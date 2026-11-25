"use client";
import { useRef, useState } from "react";
import { createClient } from "@/lib/supabase/browser";
import { submitProfilePhoto, type PhotoState } from "./actions";

function newId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const VIEW = 260; // size of the round frame on screen, in px
const OUT = 512; // saved photo size

type Pos = { zoom: number; x: number; y: number };

/** Keep the photo covering the whole frame. */
function clamp(img: HTMLImageElement, p: Pos): Pos {
  const scale = (VIEW / Math.min(img.naturalWidth, img.naturalHeight)) * p.zoom;
  const mx = Math.max(0, (img.naturalWidth * scale - VIEW) / 2), my = Math.max(0, (img.naturalHeight * scale - VIEW) / 2);
  return { zoom: p.zoom, x: Math.min(mx, Math.max(-mx, p.x)), y: Math.min(my, Math.max(-my, p.y)) };
}

/** Cuts out exactly what the frame shows and saves it as a 512 x 512 JPEG. */
async function crop(img: HTMLImageElement, p: Pos): Promise<Blob> {
  const scale = (VIEW / Math.min(img.naturalWidth, img.naturalHeight)) * p.zoom;
  const left = VIEW / 2 - (img.naturalWidth * scale) / 2 + p.x, top = VIEW / 2 - (img.naturalHeight * scale) / 2 + p.y;
  const c = document.createElement("canvas"); c.width = OUT; c.height = OUT;
  c.getContext("2d")!.drawImage(img, -left / scale, -top / scale, VIEW / scale, VIEW / scale, 0, 0, OUT, OUT);
  return await new Promise<Blob>((ok, bad) => c.toBlob((b) => (b ? ok(b) : bad(new Error("photo"))), "image/jpeg", 0.85));
}

export function PhotoUpload({ userId }: { userId: string }) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [pos, setPos] = useState<Pos>({ zoom: 1, x: 0, y: 0 });
  const drag = useRef<{ id: number; x: number; y: number; px: number; py: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<PhotoState>(undefined);

  async function choose(f: File | undefined) {
    setRes(undefined);
    if (!f) return;
    const url = URL.createObjectURL(f);
    try {
      const i = await new Promise<HTMLImageElement>((ok, bad) => { const x = new Image(); x.onload = () => ok(x); x.onerror = bad; x.src = url; });
      setImg((old) => { if (old) URL.revokeObjectURL(old.src); return i; });
      setPos({ zoom: 1, x: 0, y: 0 });
    } catch { URL.revokeObjectURL(url); setRes({ error: "That file isn't a photo we can read. Try another one." }); }
  }

  async function send() {
    if (!img) return;
    setBusy(true); setRes(undefined);
    let blob: Blob;
    try { blob = await crop(img, pos); } catch { setBusy(false); setRes({ error: "Could not prepare the photo. Try another one." }); return; }
    const path = `${userId}/${newId()}.jpg`;
    const { error } = await createClient().storage.from("profile-photos").upload(path, blob, { contentType: "image/jpeg" });
    if (error) { setBusy(false); setRes({ error: "Could not upload the photo. Check your internet and try again." }); return; }
    const r = await submitProfilePhoto(path);
    setBusy(false); setRes(r);
    if (r?.ok) setImg(null);
  }

  const scale = img ? (VIEW / Math.min(img.naturalWidth, img.naturalHeight)) * pos.zoom : 1;
  return (
    <div className="photo-pick">
      {img && (
        <>
          <div className="photo-frame" style={{ width: VIEW, height: VIEW }}
            onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, px: pos.x, py: pos.y }; }}
            onPointerMove={(e) => { const d = drag.current; if (!d || d.id !== e.pointerId) return; setPos(clamp(img, { zoom: pos.zoom, x: d.px + e.clientX - d.x, y: d.py + e.clientY - d.y })); }}
            onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={img.src} alt="Your new profile picture" draggable={false} style={{
              width: img.naturalWidth * scale, height: img.naturalHeight * scale,
              left: VIEW / 2 - (img.naturalWidth * scale) / 2 + pos.x, top: VIEW / 2 - (img.naturalHeight * scale) / 2 + pos.y }} />
          </div>
          <label className="photo-zoom small">Zoom
            <input type="range" min={1} max={4} step={0.01} value={pos.zoom} onChange={(e) => setPos(clamp(img, { ...pos, zoom: Number(e.target.value) }))} />
          </label>
          <p className="small muted" style={{ margin: 0 }}>Drag the photo to move it. Use Zoom to make your face bigger. What you see in the circle is what gets saved.</p>
        </>
      )}
      <label className="button secondary">
        {img ? "Choose a different photo" : "Choose a photo"}
        <input type="file" accept="image/*" hidden onChange={(e) => choose(e.target.files?.[0])} />
      </label>
      {img && <button type="button" onClick={send} disabled={busy}>{busy ? "Sending…" : "Send for approval"}</button>}
      {res?.ok && <div className="notice ok">{res.ok}</div>}
      {res?.error && <div className="notice error">{res.error}</div>}
    </div>
  );
}
