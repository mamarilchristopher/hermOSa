"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/browser";
import { clockPunch, setBranchLocation, type PunchState } from "./actions";
import { parseCoords } from "@/lib/schedule";
import { photoTakenAt } from "@/lib/exif";
import { IconCamera, IconImage, IconLogout } from "@/components/Icons";

type B = { id: string; name: string; wfh?: boolean };
const PENDING = "hermosa-pending-punch";
/** A random v4 UUID. crypto.randomUUID is missing in some in-app browsers (Messenger) and older phones. */
function newId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
/** A short reason from any error, for the on-screen message. */
const why = (e: unknown) => (e instanceof Error ? e.message : typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e)).slice(0, 120) || "unknown";

/** Shrinks the time-in photo to about 1024 px JPEG (clock still readable, well under the 1 MB limit) before upload.
 *  Screenshots (WFH) keep more pixels so the small clock corner stays readable; quality steps down to stay under 1 MB. */
async function shrink(file: File, max = 1024): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = url; });
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement("canvas");
    c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
    c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
    const jpeg = (q: number) => new Promise<Blob>((ok, bad) => c.toBlob((b) => (b ? ok(b) : bad(new Error("photo"))), "image/jpeg", q));
    let out = await jpeg(0.8);
    for (const q of [0.65, 0.5]) if (out.size > 950_000) out = await jpeg(q);
    return out;
  } finally { URL.revokeObjectURL(url); }
}

/** Gives up after `ms` so a stuck step shows an error instead of spinning forever. */
function within<T>(p: Promise<T>, ms: number, fallback: () => T): Promise<T> {
  return new Promise((ok, bad) => {
    const t = setTimeout(() => ok(fallback()), ms);
    p.then((v) => { clearTimeout(t); ok(v); }, (e) => { clearTimeout(t); bad(e); });
  });
}

/** The phone's location, or nothing if it's off or slow. Never blocks the punch.
 *  The browser's own timeout doesn't count time spent on the permission pop-up, so we cap it ourselves. */
function locate(): Promise<GeolocationPosition | null> {
  const ask = new Promise<GeolocationPosition | null>((ok) => {
    if (!navigator.geolocation) return ok(null);
    navigator.geolocation.getCurrentPosition(ok, () => ok(null), { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
  });
  return within(ask, 15000, () => null);
}

function Now() {
  const [t, setT] = useState<string | null>(null);
  useEffect(() => {
    const f = () => setT(new Date().toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Manila" }));
    f(); const i = setInterval(f, 10000); return () => clearInterval(i);
  }, []);
  return <div className="clock-now" suppressHydrationWarning>{t ?? " "}</div>;
}

export function TimeClock({ userId, isIn, branches, defaultBranch, status, managerShot = false }: { userId: string; isIn: boolean; branches: B[]; defaultBranch: string; status: string; managerShot?: boolean }) {
  const router = useRouter();
  const [branch, setBranch] = useState(defaultBranch);
  const [busy, setBusy] = useState<string | null>(null);
  const [res, setRes] = useState<PunchState>();
  const [noLoc, setNoLoc] = useState(false);
  const [reload, setReload] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const shot = useRef<HTMLInputElement>(null); // WFH: pick a screenshot instead of taking a photo (CHRIS Nov 25)
  const kind = isIn ? "OUT" : "IN";
  /** Working from home (CSRs, update-0038): the photo is of the PC's clock, and no location is asked for. */
  const online = !!branches.find((b) => b.id === branch)?.wfh;

  /** Sends the punch. If the app was updated while this page was open, the old page can't reach the new
   *  server code and the call throws: keep the uploaded photo, reload once, and finish the punch after. */
  async function send(args: Parameters<typeof clockPunch>[0], fromReload = false) {
    let r: PunchState;
    try {
      r = await clockPunch(args);
    } catch (e) {
      if (!fromReload) {
        try { sessionStorage.setItem(PENDING, JSON.stringify({ ...args, saved: Date.now() })); window.location.reload(); return; } catch { /* no storage */ }
      }
      setRes({ error: `Could not reach Hermosa OS to save your ${args.kind === "IN" ? "time in" : "time out"}. Reload this page and try again. (${why(e)})` }); setReload(true); return;
    }
    setRes(r); setNoLoc(args.lat == null);
    if (r?.ok) router.refresh();
  }

  // Finish a punch that was interrupted by an app update (see send).
  useEffect(() => {
    let p: (Parameters<typeof clockPunch>[0] & { saved: number }) | null = null;
    try { const raw = sessionStorage.getItem(PENDING); sessionStorage.removeItem(PENDING); p = raw ? JSON.parse(raw) : null; } catch { /* ignore */ }
    if (!p || Date.now() - p.saved > 120000) return;
    const { saved: _saved, ...args } = p; void _saved;
    setBusy(args.kind === "IN" ? "Timing in…" : "Timing out…");
    send(args, true).finally(() => setBusy(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onPhoto(f: File | undefined, screenshot = false) {
    if (!f) return;
    setRes(undefined); setNoLoc(false); setReload(false);
    let step = "photo";
    try {
      setBusy(online ? "Preparing your photo…" : "Getting your location…");
      const [blob, pos, taken] = await Promise.all([shrink(f, screenshot ? 2000 : 1024).catch(() => null), online ? Promise.resolve(null) : locate(), f.slice(0, 262144).arrayBuffer().then((b) => photoTakenAt(b), () => null)]);
      if (!blob) { setRes({ error: "This photo couldn't be read. Take the photo again with the phone's camera." }); return; }
      setBusy("Saving your photo…"); step = "upload";
      const path = `${userId}/${newId()}.jpg`;
      const up = createClient().storage.from("timeclock").upload(path, blob, { contentType: "image/jpeg" });
      const { error } = await within(up, 30000, () => ({ data: null, error: new Error("timeout") }) as unknown as Awaited<typeof up>);
      if (error) { setRes({ error: `Could not upload the photo. Check your internet and try again. (${why(error)})` }); return; }
      step = "save";
      setBusy(kind === "IN" ? "Timing in…" : "Timing out…");
      await send({ kind, branch, photo: path, lat: pos?.coords.latitude, lng: pos?.coords.longitude,
        acc: pos ? Math.round(pos.coords.accuracy) : undefined,
        // Screenshots have no camera time: use the file's saved time, so the photos page can flag an old screenshot.
        taken: taken ?? (screenshot && f.lastModified ? new Date(f.lastModified).toISOString() : undefined) });
    } catch (e) {
      // Shown in full so a screenshot tells us exactly which step failed.
      setRes({ error: step === "upload" ? `Could not upload the photo. Check your internet and try again. (${why(e)})`
        : `Something went wrong (${step}: ${why(e)}). Reload this page and try again.` }); setReload(true);
    } finally {
      setBusy(null);
      if (file.current) file.current.value = "";
      if (shot.current) shot.current.value = "";
    }
  }

  return (
    <div className="card clock-card">
      <Now />
      <div className="clock-status muted">{status}</div>
      {/* update-0097 (CHRIS Nov 27): staff rotate, so they say where they're assigned today (default = home branch).
          The Service log uses this branch for today's staff lists. */}
      {!isIn && branches.length > 1 && (
        <div className="field clock-branch">
          <span className="field-label">Branch assigned today</span>
          <div className="segmented choice" role="radiogroup" aria-label="Branch assigned today">
            {branches.map((b) => (
              <button type="button" key={b.id} role="radio" aria-checked={branch === b.id} className={branch === b.id ? "on" : ""} onClick={() => setBranch(b.id)}>{b.name}</button>
            ))}
          </div>
        </div>
      )}
      <input ref={file} type="file" accept="image/*" capture="environment" hidden onChange={(e) => onPhoto(e.target.files?.[0])} />
      <button className={`clock-btn ${isIn ? "out" : ""}`} disabled={!!busy || !branch} onClick={() => file.current?.click()}>
        {!busy && (isIn ? <IconLogout /> : <IconCamera />)}{busy ?? (isIn ? "Time out" : "Time in")}
      </button>
      {/* Screenshots: WFH staff for in and out; management (owners and the GM) for time out too (CHRIS Nov 25). */}
      {(online || (managerShot && isIn)) && <>
        <input ref={shot} type="file" accept="image/*" hidden onChange={(e) => onPhoto(e.target.files?.[0], true)} />
        <button type="button" className="secondary" disabled={!!busy || !branch} onClick={() => shot.current?.click()}>
          <IconImage />{isIn ? "Time out" : "Time in"} with a screenshot
        </button>
      </>}
      {/* Example photo (CHRIS, Nov 25): one for CSRs working from home, one for everyone at a clinic. */}
      <img className="time-example" src={online ? "/time-in-csr.svg" : "/time-in-clinic.svg"} alt={online ? "Example: phone photo of the PC clock corner showing time and date" : "Example: phone photo of the clinic clock showing time and date"} />
      <p className="small muted" style={{ margin: 0 }}>{online
        ? "Working from home: take a photo of your PC's clock showing the date and time (bottom corner of the screen), or upload a screenshot of your screen where the clock and date show. The server time is saved with it."
        : "Take a photo of the clinic clock showing the date and time. The server time and your location are saved with it."}</p>
      {busy === "Getting your location…" && <div className="notice info">If your phone asks, tap Allow for location. This takes up to 15 seconds.</div>}
      {res?.error && <div className="notice error">{res.error}{reload && <> <button className="secondary small" onClick={() => window.location.reload()}>Reload</button></>}</div>}
      {res?.ok && noLoc && !online && <div className="notice warn">Saved without your location. Turn on location for this browser so next time shows you&apos;re at the clinic.</div>}
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
