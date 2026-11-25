"use client";
// Before/after and waiver photos for a logged visit (update-0053). Each photo uploads the moment it's picked:
// the ORIGINAL file, untouched (no compression), plus a small preview for the archive grid.
import { useState } from "react";
import { createClient } from "@/lib/supabase/browser";

export type PhotoKind = "BEFORE" | "AFTER" | "WAIVER";
export type Slot = { key: string; kind: PhotoKind; preview: string; path?: string; thumb?: string | null; status: "uploading" | "done" | "error" };

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "image/heif": "heif" };
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
  (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(c) / 4)))).toString(16)));

/** A ~400px JPEG preview. Returns null when the browser can't read the format (e.g. HEIC outside Safari). */
async function thumbOf(file: File): Promise<Blob | null> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = url; });
    const s = Math.min(1, 400 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(img.naturalWidth * s)); c.height = Math.max(1, Math.round(img.naturalHeight * s));
    c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
    return await new Promise<Blob | null>((ok) => c.toBlob((b) => ok(b), "image/jpeg", 0.8));
  } catch { return null; } finally { URL.revokeObjectURL(url); }
}

export function usePhotoSlots(branch: string) {
  const [folder, setFolder] = useState(uuid);
  const [slots, setSlots] = useState<Slot[]>([]);
  const patch = (key: string, p: Partial<Slot>) => setSlots((l) => l.map((s) => (s.key === key ? { ...s, ...p } : s)));

  const add = async (kind: PhotoKind, files: FileList | null) => {
    for (const file of Array.from(files ?? [])) {
      const key = uuid();
      const ext = EXT[file.type] ?? (/\.(heic|heif)$/i.test(file.name) ? file.name.split(".").pop()!.toLowerCase() : null);
      if (!ext) { alert("Only photos (JPG, PNG, WEBP or HEIC) can be added."); continue; }
      setSlots((l) => [...l, { key, kind, preview: URL.createObjectURL(file), status: "uploading" }]);
      const sb = createClient();
      const path = `${branch}/${folder}/${kind.toLowerCase()}-${key}.${ext}`;
      const { error } = await sb.storage.from("client-photos").upload(path, file, { contentType: file.type || `image/${ext}`, cacheControl: "31536000" });
      if (error) { patch(key, { status: "error" }); continue; }
      let thumb: string | null = null;
      const t = await thumbOf(file);
      if (t) {
        const tp = `${branch}/${folder}/thumb-${key}.jpg`;
        if (!(await sb.storage.from("client-photos").upload(tp, t, { contentType: "image/jpeg" })).error) thumb = tp;
      }
      patch(key, { status: "done", path, thumb });
    }
  };
  const remove = (key: string) => setSlots((l) => { const s = l.find((x) => x.key === key); if (s) URL.revokeObjectURL(s.preview); return l.filter((x) => x.key !== key); });
  const reset = () => { slots.forEach((s) => URL.revokeObjectURL(s.preview)); setSlots([]); setFolder(uuid()); };
  const json = JSON.stringify(slots.filter((s) => s.status === "done").map((s) => ({ kind: s.kind, path: s.path, thumb: s.thumb ?? null })));
  const count = (k: PhotoKind) => slots.filter((s) => s.kind === k && s.status === "done").length;
  return { folder, slots, add, remove, reset, json, count, uploading: slots.some((s) => s.status === "uploading") };
}

type Api = ReturnType<typeof usePhotoSlots>;

export function PhotoGroup({ api, kinds, title, hint }: { api: Api; kinds: { kind: PhotoKind; label: string }[]; title: string; hint?: string }) {
  const mine = api.slots.filter((s) => kinds.some((k) => k.kind === s.kind));
  return (
    <div className="field photo-group">
      <span className="field-label">{title}</span>
      {hint && <span className="small muted">{hint}</span>}
      <div className="photo-row">
        {mine.map((s) => (
          <figure key={s.key} className={`photo-slot ${s.status}`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={s.preview} alt={`${s.kind.toLowerCase()} photo`} />
            <figcaption>{s.status === "uploading" ? "Uploading…" : s.status === "error" ? "Didn't upload" : s.kind === "WAIVER" ? `Page ${mine.filter((x) => x.kind === "WAIVER").indexOf(s) + 1}` : s.kind === "BEFORE" ? "Before" : "After"}</figcaption>
            <button type="button" className="photo-x" aria-label="Remove photo" onClick={() => api.remove(s.key)}>×</button>
          </figure>
        ))}
        {kinds.map((k) => (
          <label key={k.kind} className="photo-add">
            <input type="file" accept="image/*,.heic,.heif" multiple hidden
              onChange={(e) => { void api.add(k.kind, e.target.files); e.target.value = ""; }} />
            <span aria-hidden>＋</span>{k.label}
          </label>
        ))}
      </div>
    </div>
  );
}
