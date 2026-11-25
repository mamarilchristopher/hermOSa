"use client";
import { useState } from "react";
import { createClient } from "@/lib/supabase/browser";
import { submitProfilePhoto, type PhotoState } from "./actions";

function newId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Crops the middle square and shrinks it to 512 x 512 JPEG. */
async function square(file: File): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = url; });
    const s = Math.min(img.width, img.height), N = 512;
    const c = document.createElement("canvas"); c.width = N; c.height = N;
    c.getContext("2d")!.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, N, N);
    return await new Promise<Blob>((ok, bad) => c.toBlob((b) => (b ? ok(b) : bad(new Error("photo"))), "image/jpeg", 0.85));
  } finally { URL.revokeObjectURL(url); }
}

export function PhotoUpload({ userId }: { userId: string }) {
  const [blob, setBlob] = useState<Blob | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<PhotoState>(undefined);

  async function pick(f: File | undefined) {
    setRes(undefined);
    if (!f) return;
    try { const b = await square(f); setBlob(b); setPreview((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(b); }); }
    catch { setRes({ error: "That file isn't a photo we can read. Try another one." }); }
  }

  async function send() {
    if (!blob) return;
    setBusy(true); setRes(undefined);
    const path = `${userId}/${newId()}.jpg`;
    const { error } = await createClient().storage.from("profile-photos").upload(path, blob, { contentType: "image/jpeg" });
    if (error) { setBusy(false); setRes({ error: "Could not upload the photo. Check your internet and try again." }); return; }
    const r = await submitProfilePhoto(path);
    setBusy(false); setRes(r);
    if (r?.ok) setBlob(null);
  }

  return (
    <div className="photo-pick">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {preview && <img className="photo-preview" src={preview} alt="Your new profile picture" />}
      <label className="button secondary">
        {preview ? "Choose a different photo" : "Choose a photo"}
        <input type="file" accept="image/*" hidden onChange={(e) => pick(e.target.files?.[0])} />
      </label>
      {blob && <button type="button" onClick={send} disabled={busy}>{busy ? "Sending…" : "Send for approval"}</button>}
      {res?.ok && <div className="notice ok">{res.ok}</div>}
      {res?.error && <div className="notice error">{res.error}</div>}
    </div>
  );
}
