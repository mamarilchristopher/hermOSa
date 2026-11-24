"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/browser";
import { clockPunch, setBranchLocation, type PunchState } from "./actions";
import { parseCoords } from "@/lib/schedule";

type B = { id: string; name: string };

/** Shrinks the clock photo to about 480 px wide JPEG (well under the 1 MB limit) before upload. */
async function shrink(file: File): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = url; });
    const scale = Math.min(1, 480 / Math.max(img.width, img.height));
    const c = document.createElement("canvas");
    c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
    c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
    return await new Promise<Blob>((ok, bad) => c.toBlob((b) => (b ? ok(b) : bad(new Error("photo"))), "image/jpeg", 0.72));
  } finally { URL.revokeObjectURL(url); }
}

/** The phone's location, or nothing if it's off or slow. Never blocks the punch. */
function locate(): Promise<GeolocationPosition | null> {
  return new Promise((ok) => {
    if (!navigator.geolocation) return ok(null);
    navigator.geolocation.getCurrentPosition(ok, () => ok(null), { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
  });
}

function Now() {
  const [t, setT] = useState<string | null>(null);
  useEffect(() => {
    const f = () => setT(new Date().toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Manila" }));
    f(); const i = setInterval(f, 10000); return () => clearInterval(i);
  }, []);
  return <div className="clock-now" suppressHydrationWarning>{t ?? " "}</div>;
}

export function TimeClock({ userId, isIn, branches, defaultBranch, status }: { userId: string; isIn: boolean; branches: B[]; defaultBranch: string; status: string }) {
  const router = useRouter();
  const [branch, setBranch] = useState(defaultBranch);
  const [busy, setBusy] = useState<string | null>(null);
  const [res, setRes] = useState<PunchState>();
  const file = useRef<HTMLInputElement>(null);
  const kind = isIn ? "OUT" : "IN";

  async function onPhoto(f: File | undefined) {
    if (!f) return;
    setRes(undefined);
    try {
      setBusy("Saving your photo…");
      const [blob, pos] = await Promise.all([shrink(f), locate()]);
      const path = `${userId}/${crypto.randomUUID()}.jpg`;
      const { error } = await createClient().storage.from("timeclock").upload(path, blob, { contentType: "image/jpeg" });
      if (error) { setRes({ error: "Could not upload the photo. Check your internet and try again." }); return; }
      setBusy(kind === "IN" ? "Timing in…" : "Timing out…");
      const r = await clockPunch({ kind, branch, photo: path, lat: pos?.coords.latitude, lng: pos?.coords.longitude,
        acc: pos ? Math.round(pos.coords.accuracy) : undefined });
      setRes(r);
      if (r?.ok) router.refresh();
    } catch {
      setRes({ error: "Something went wrong. Try again." });
    } finally {
      setBusy(null);
      if (file.current) file.current.value = "";
    }
  }

  return (
    <div className="card clock-card">
      <Now />
      <div className="clock-status muted">{status}</div>
      {!isIn && branches.length > 1 && (
        <select value={branch} onChange={(e) => setBranch(e.target.value)} aria-label="Branch">
          {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      )}
      <input ref={file} type="file" accept="image/*" capture="environment" hidden onChange={(e) => onPhoto(e.target.files?.[0])} />
      <button className={`clock-btn ${isIn ? "out" : ""}`} disabled={!!busy || !branch} onClick={() => file.current?.click()}>
        {busy ?? (isIn ? "Time out" : "Time in")}
      </button>
      <p className="small muted" style={{ margin: 0 }}>Take a photo of the clinic clock. Your location and the server time are saved with it, not your phone's time.</p>
      {res?.error && <div className="notice error">{res.error}</div>}
      {res?.ok && <div className="notice ok">{res.ok}{res.far != null && res.far > 300 && ` Your phone looked about ${res.far >= 1000 ? `${(res.far / 1000).toFixed(1)} km` : `${res.far} m`} away from the branch, so a manager may check.`}</div>}
    </div>
  );
}

/** Owners and managers, standing in the clinic: save this phone's location as the branch's. */
export function BranchLocation({ branches }: { branches: (B & { set: boolean })[] }) {
  const [branch, setBranch] = useState(branches[0]?.id ?? "");
  const [res, setRes] = useState<PunchState>();
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  async function save() {
    setBusy(true); setRes(undefined);
    const pos = await locate();
    if (!pos) { setRes({ error: "Turn on location for this browser, then try again." }); setBusy(false); return; }
    const r = await setBranchLocation({ branch, lat: pos.coords.latitude, lng: pos.coords.longitude });
    setRes(r); setBusy(false);
    if (r?.ok) router.refresh();
  }
  const [pasted, setPasted] = useState("");
  async function savePasted() {
    const c = parseCoords(pasted);
    if (!c) { setRes({ error: pasted.includes("goo.gl") ? "Short links can't be read. Open the link, then copy the numbers (see the steps below)." : "Paste the coordinates, like 14.6507, 121.0494." }); return; }
    setBusy(true); setRes(undefined);
    const r = await setBranchLocation({ branch, lat: c.lat, lng: c.lng });
    setRes(r); setBusy(false);
    if (r?.ok) { setPasted(""); router.refresh(); }
  }
  return (
    <div className="field-grid">
      <label className="field half">Branch
        <select value={branch} onChange={(e) => setBranch(e.target.value)}>
          {branches.map((b) => <option key={b.id} value={b.id}>{b.name}{b.set ? " (saved)" : " (not set)"}</option>)}
        </select></label>
      <label className="field half">Coordinates or Google Maps link
        <input value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="14.6507, 121.0494" /></label>
      <div className="field row-buttons">
        <button className="small" disabled={busy || !pasted.trim()} onClick={savePasted}>Save location</button>
        <button className="secondary small" disabled={busy} onClick={save}>{busy ? "Saving…" : "Or use this phone's location"}</button>
        {res?.error && <span className="field-error">{res.error}</span>}
        {res?.ok && <span className="small ok-text">{res.ok}</span>}
      </div>
      <p className="field small muted" style={{ margin: 0 }}>To get the numbers: in Google Maps, press and hold (phone) or right-click (PC) on the clinic&apos;s building. The coordinates show at the top of the menu or in the search bar. Copy them and paste here.</p>
    </div>
  );
}
