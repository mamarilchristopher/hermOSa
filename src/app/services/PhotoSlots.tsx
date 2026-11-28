"use client";
// Before/after and waiver photos for a logged visit (update-0053). Each photo uploads the moment it's picked:
// the ORIGINAL file, untouched (no compression), plus a small preview for the archive grid.
import { useState } from "react";
import { createClient } from "@/lib/supabase/browser";
import { IconCamera } from "@/components/Icons";

export type PhotoKind = "BEFORE" | "AFTER" | "WAIVER";
/** card (update-0104, CHRIS Nov 28): the client's session card for a fully paid package, saved as a WAIVER page named sessioncard-…. */
export type Slot = { key: string; kind: PhotoKind; card?: boolean; preview: string; path?: string; thumb?: string | null; status: "uploading" | "done" | "error" };

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "image/heif": "heif" };
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
  (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(c) / 4)))).toString(16)));

/** A ~400px JPEG preview. Returns null when the browser can't read the format (e.g. HEIC outside Safari). */
export async function thumbOf(file: File): Promise<Blob | null> {
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

export function usePhotoSlots(branch: string, fixedFolder?: string | null) {
  const [folder, setFolder] = useState(() => fixedFolder || uuid());
  const [slots, setSlots] = useState<Slot[]>([]);
  const patch = (key: string, p: Partial<Slot>) => setSlots((l) => l.map((s) => (s.key === key ? { ...s, ...p } : s)));

  /**
   * "AUTO" (CHRIS Nov 26: one button for before and after, picked as a batch): photos are ordered by when they were
   * taken; the earlier half become Before, the later half After. One photo alone fills whichever is still missing.
   * Staff tap a photo's label to switch it.
   */
  const add = async (pick: PhotoKind | "AUTO" | "CARD", files: FileList | null) => {
    const list = Array.from(files ?? []).sort((a, b) => a.lastModified - b.lastModified);
    const haveBefore = slots.some((x) => x.kind === "BEFORE");
    const kindAt = (i: number): PhotoKind => pick === "CARD" ? "WAIVER" : pick !== "AUTO" ? pick
      : list.length === 1 ? (haveBefore ? "AFTER" : "BEFORE") : i < Math.ceil(list.length / 2) ? "BEFORE" : "AFTER";
    for (const [i, file] of list.entries()) {
      const kind = kindAt(i);
      const key = uuid();
      const ext = EXT[file.type] ?? (/\.(heic|heif)$/i.test(file.name) ? file.name.split(".").pop()!.toLowerCase() : null);
      if (!ext) { alert("Only photos (JPG, PNG, WEBP or HEIC) can be added."); continue; }
      const card = pick === "CARD";
      setSlots((l) => [...l, { key, kind, card, preview: URL.createObjectURL(file), status: "uploading" }]);
      const sb = createClient();
      const path = `${branch}/${folder}/${card ? "sessioncard" : kind.toLowerCase()}-${key}.${ext}`;
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
  const flip = (key: string) => setSlots((l) => l.map((x) => (x.key === key && x.kind !== "WAIVER" && !x.card ? { ...x, kind: x.kind === "BEFORE" ? "AFTER" : "BEFORE" } : x)));
  const remove = (key: string) => setSlots((l) => { const s = l.find((x) => x.key === key); if (s) URL.revokeObjectURL(s.preview); return l.filter((x) => x.key !== key); });
  const reset = () => { slots.forEach((s) => URL.revokeObjectURL(s.preview)); setSlots([]); setFolder(uuid()); };
  const jsonOf = (only?: (s: Slot) => boolean) => JSON.stringify(slots.filter((s) => s.status === "done" && (!only || only(s))).map((s) => ({ kind: s.kind, path: s.path, thumb: s.thumb ?? null })));
  const json = jsonOf();
  const cards = slots.filter((s) => s.card && s.status === "done").length;
  const count = (k: PhotoKind) => slots.filter((s) => s.kind === k && !s.card && s.status === "done").length;
  return { folder, slots, add, flip, remove, reset, json, jsonOf, cards, count, uploading: slots.some((s) => s.status === "uploading") };
}

type Api = ReturnType<typeof usePhotoSlots>;

export function PhotoGroup({ api, kinds, title, hint, max }: { api: Api; kinds: { kind: PhotoKind | "AUTO" | "CARD"; label: string }[]; title: string; hint?: string; max?: number }) {
  const auto = kinds.some((k) => k.kind === "AUTO");
  const cardGroup = kinds.some((k) => k.kind === "CARD");
  const mine = api.slots.filter((s) => (cardGroup ? !!s.card : s.card ? false : auto ? s.kind !== "WAIVER" : kinds.some((k) => k.kind === s.kind)));
  return (
    <div className="field photo-group">
      <span className="field-label">{title}</span>
      {hint && <span className="small muted">{hint}</span>}
      <div className="photo-row">
        {mine.map((s) => (
          <figure key={s.key} className={`photo-slot ${s.status}`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={s.preview} alt={`${s.kind.toLowerCase()} photo`} />
            {s.status === "done" && s.card ? <figcaption>Session card</figcaption> : s.status === "done" && s.kind !== "WAIVER" ? (
              <figcaption><button type="button" className={`ba-toggle ${s.kind === "BEFORE" ? "before" : "after"}`} onClick={() => api.flip(s.key)} title="Tap to switch">
                {s.kind === "BEFORE" ? "Before" : "After"} ⇄</button></figcaption>
            ) : (
              <figcaption>{s.status === "uploading" ? "Uploading…" : s.status === "error" ? "Didn't upload" : `Page ${mine.filter((x) => x.kind === "WAIVER").indexOf(s) + 1}`}</figcaption>
            )}
            <button type="button" className="photo-x" aria-label="Remove photo" onClick={() => api.remove(s.key)}>×</button>
          </figure>
        ))}
        {(max === undefined || mine.length < max) && kinds.map((k) => (
          <label key={k.kind} className="photo-add">
            <input type="file" accept="image/*,.heic,.heif" multiple={max !== 1} hidden
              onChange={(e) => { void api.add(k.kind, e.target.files); e.target.value = ""; }} />
            <span aria-hidden>＋</span>{k.label}
          </label>
        ))}
      </div>
    </div>
  );
}

/** Service log (update-0054): add the missing photos to an entry logged without them. */
export function AddPhotosLater({ log, branch, folder, needs }: { log: string; branch: string; folder: string | null; needs: string }) {
  const api = usePhotoSlots(branch, folder);
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<{ ok?: string; error?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (msg?.ok === "done") return <span className="pill PUBLISHED">Photos complete</span>;
  if (!open) return <button type="button" className="small" onClick={() => setOpen(true)}><IconCamera />Add photos</button>;
  const save = async () => {
    setBusy(true); setMsg(null);
    const { data, error } = await createClient().rpc("add_visit_photos", { p_log: log, p_folder: api.folder, p_photos: JSON.parse(api.json) });
    setBusy(false);
    if (error || !data?.ok) { setMsg({ error: data?.error === "PHOTO_NOT_UPLOADED" ? "A photo didn't finish uploading. Remove it and add it again." : "Could not save. Try again." }); return; }
    if (data.complete) { setMsg({ ok: "done" }); return; }
    api.reset();
    setMsg({ ok: `Saved. Still needed: ${[data.before < 1 && "a before photo", data.after < 1 && "an after photo", data.waivers < 2 && `${2 - data.waivers} waiver page${data.waivers === 1 ? "" : "s"}`].filter(Boolean).join(", ")}.` });
  };
  return (
    <div className="add-later">
      <span className="small muted">Needed: {needs}</span>
      <PhotoGroup api={api} title="Before and after photos" kinds={[{ kind: "AUTO", label: "Add before & after photos" }]}
        hint="Pick them all at once. Tap a photo's label to switch Before / After." />
      <PhotoGroup api={api} title="Waiver (2 pages)" kinds={[{ kind: "WAIVER", label: "Add waiver page" }]} />
      <div className="fill-row">
        <button type="button" className="small" disabled={busy || api.uploading || api.slots.every((s) => s.status !== "done")} onClick={save}>
          {busy ? "Saving…" : api.uploading ? "Uploading…" : "Save photos"}</button>
        <button type="button" className="secondary small" onClick={() => { api.reset(); setOpen(false); }}>Cancel</button>
      </div>
      {msg?.ok && <span className="small" style={{ color: "var(--good)" }}>{msg.ok}</span>}
      {msg?.error && <span className="small" style={{ color: "var(--bad)" }}>{msg.error}</span>}
    </div>
  );
}
