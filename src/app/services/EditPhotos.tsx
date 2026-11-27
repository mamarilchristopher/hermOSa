"use client";
// update-0093 (CHRIS Nov 27): edit the photos of a past Service log entry (waivers included): add, remove or replace.
// Staff send the change with a reason; it saves only when an owner or the GM approves (their own changes save at once).
// Replaced and removed photos are kept in the client's folder under "Old".
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/browser";
import { PhotoGroup, thumbOf, usePhotoSlots, type PhotoKind } from "./PhotoSlots";
import { viewPhoto } from "@/components/PhotoViewer";

type Photo = { id: string; kind: PhotoKind; path: string; thumb: string | null };
type Loaded = { folder: string | null; photos: Photo[]; pending: { id: string; note: string; mine: boolean; count: number } | null };
type Swap = { path: string; thumb: string | null; preview: string };
const KIND = { BEFORE: "Before", AFTER: "After", WAIVER: "Waiver" } as const;
const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "image/heif": "heif" };
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
  (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(c) / 4)))).toString(16)));

export function EditPhotos({ log, branch, approver }: { log: string; branch: string; approver: boolean }) {
  const [data, setData] = useState<Loaded | null>(null);
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<{ ok?: string; error?: string } | null>(null);
  if (msg?.ok && !open) return <span className="small" style={{ color: "var(--good)" }}>{msg.ok}</span>;
  if (!open) return (
    <button type="button" className="secondary small" onClick={async () => {
      setOpen(true); setMsg(null);
      const { data: d, error } = await createClient().rpc("entry_photos", { p_log: log });
      if (error || !d?.ok) { setMsg({ error: error?.code === "PGRST202" ? "Editing photos needs database update-0093. Ask the owner to run it." : "Could not load the photos." }); return; }
      setData({ folder: d.folder ?? null, photos: d.photos ?? [], pending: d.pending ?? null });
    }}>Edit photos</button>
  );
  return (
    <div className="add-later edit-photos">
      {!data ? <span className="small muted">{msg?.error ?? "Loading photos…"}</span>
        : <Editor log={log} branch={branch} approver={approver} data={data} done={(ok) => { setOpen(false); setMsg({ ok }); }} close={() => setOpen(false)} />}
      {!data && msg?.error && <button type="button" className="secondary small" onClick={() => setOpen(false)}>Close</button>}
    </div>
  );
}

function Editor({ log, branch, approver, data, done, close }: { log: string; branch: string; approver: boolean; data: Loaded; done: (ok: string) => void; close: () => void }) {
  const router = useRouter();
  const sb = createClient();
  const adds = usePhotoSlots(branch, data.folder);
  const folder = adds.folder;
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [swaps, setSwaps] = useState<Record<string, Swap | "uploading" | "error">>({});
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const paths = data.photos.flatMap((p) => [p.path, p.thumb].filter((x): x is string => !!x));
    if (paths.length) void createClient().storage.from("client-photos").createSignedUrls(paths, 3600).then(({ data: s }) => {
      const out: Record<string, string> = {};
      for (const x of s ?? []) if (x.path && x.signedUrl) out[x.path] = x.signedUrl;
      setUrls(out);
    });
  }, [data.photos]);

  const replace = async (p: Photo, file: File | undefined) => {
    if (!file) return;
    const ext = EXT[file.type] ?? (/\.(heic|heif)$/i.test(file.name) ? file.name.split(".").pop()!.toLowerCase() : null);
    if (!ext) { alert("Only photos (JPG, PNG, WEBP or HEIC) can be added."); return; }
    setSwaps((s) => ({ ...s, [p.id]: "uploading" }));
    const key = uuid();
    const path = `${branch}/${folder}/${p.kind.toLowerCase()}-${key}.${ext}`;
    const { error: e } = await sb.storage.from("client-photos").upload(path, file, { contentType: file.type || `image/${ext}`, cacheControl: "31536000" });
    if (e) { setSwaps((s) => ({ ...s, [p.id]: "error" })); return; }
    let thumb: string | null = null;
    const t = await thumbOf(file);
    if (t) { const tp = `${branch}/${folder}/thumb-${key}.jpg`; if (!(await sb.storage.from("client-photos").upload(tp, t, { contentType: "image/jpeg" })).error) thumb = tp; }
    setSwaps((s) => ({ ...s, [p.id]: { path, thumb, preview: URL.createObjectURL(file) } }));
    setRemoved((r) => { const n = new Set(r); n.delete(p.id); return n; });
  };

  const changes = [
    ...data.photos.flatMap((p) => {
      const s = swaps[p.id];
      if (s && typeof s === "object") return [{ op: "REPLACE", photo: p.id, path: s.path, thumb: s.thumb }];
      return removed.has(p.id) ? [{ op: "REMOVE", photo: p.id }] : [];
    }),
    ...(JSON.parse(adds.json) as { kind: PhotoKind; path: string; thumb: string | null }[]).map((a) => ({ op: "ADD", kind: a.kind, path: a.path, thumb: a.thumb })),
  ];
  const uploading = adds.uploading || Object.values(swaps).includes("uploading");

  const send = async () => {
    setBusy(true); setError("");
    const { data: r, error: e } = await sb.rpc("request_photo_changes", { p_log: log, p_changes: changes, p_note: note.trim() });
    setBusy(false);
    if (e || !r?.ok) {
      setError(e?.code === "PGRST202" ? "Editing photos needs database update-0093. Ask the owner to run it."
        : r?.error === "REASON_REQUIRED" ? "Write why the photos are being changed."
        : r?.error === "PHOTO_NOT_UPLOADED" ? "A photo didn't finish uploading. Add it again." : "Could not send. Try again.");
      return;
    }
    router.refresh();
    done(r.applied ? "Photos saved. Old photos are in the client's folder under Old." : "Sent. The photos change once an owner or the GM approves.");
  };

  if (data.pending) return (
    <div className="photo-edit-wait">
      <span className="pill STAGED">Photo change waiting for approval</span>
      <span className="small">{data.pending.count} change{data.pending.count === 1 ? "" : "s"}: {data.pending.note}</span>
      <div className="fill-row">
        {data.pending.mine && <button type="button" className="secondary small" onClick={async () => { await sb.rpc("cancel_photo_change", { p_id: data.pending!.id }); router.refresh(); done("Request taken back."); }}>Take back my request</button>}
        {approver && <a className="button small" href="/services/photo-changes">Review it</a>}
        <button type="button" className="secondary small" onClick={close}>Close</button>
      </div>
    </div>
  );

  return (
    <>
      <span className="field-label">Current photos</span>
      {data.photos.length === 0 ? <span className="small muted">No photos yet. Add them below.</span> : (
        <ul className="plain-list edit-grid">
          {data.photos.map((p) => {
            const s = swaps[p.id];
            const src = s && typeof s === "object" ? s.preview : p.thumb ? urls[p.thumb] : urls[p.path];
            const gone = removed.has(p.id);
            return (
              <li key={p.id} className={gone ? "gone" : s && typeof s === "object" ? "swapped" : ""}>
                <button type="button" className="edit-thumb" onClick={() => urls[p.path] && viewPhoto(urls[p.path], KIND[p.kind])} aria-label={`Open ${KIND[p.kind]} photo`}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {src ? <img src={src} alt={`${KIND[p.kind]} photo`} /> : <span className="folder-nothumb">{KIND[p.kind]}</span>}
                </button>
                <span className="small"><b>{KIND[p.kind]}</b>{gone ? " · will be removed" : s === "uploading" ? " · uploading…" : s === "error" ? " · didn't upload" : s ? " · new photo" : ""}</span>
                <span className="edit-actions">
                  <label className="button secondary small">Replace
                    <input type="file" accept="image/*,.heic,.heif" hidden onChange={(e) => { void replace(p, e.target.files?.[0]); e.target.value = ""; }} /></label>
                  <button type="button" className="secondary small" onClick={() => {
                    setRemoved((r) => { const n = new Set(r); if (n.has(p.id)) n.delete(p.id); else n.add(p.id); return n; });
                    setSwaps((x) => { const n = { ...x }; delete n[p.id]; return n; });
                  }}>{gone ? "Keep" : "Remove"}</button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <PhotoGroup api={adds} title="Add before and after photos" kinds={[{ kind: "AUTO", label: "Add before & after photos" }]} hint="Tap a photo's label to switch Before / After." />
      <PhotoGroup api={adds} title="Add waiver pages" kinds={[{ kind: "WAIVER", label: "Add waiver page" }]} />
      <label className="field">Why are the photos changing?
        <input value={note} maxLength={300} placeholder="e.g. waiver page 2 was blurry" onChange={(e) => setNote(e.target.value)} /></label>
      <span className="small muted">{approver ? "Your change saves right away. Old photos stay in the client's folder under Old." : "An owner or the GM approves it first. Old photos stay in the client's folder under Old."}</span>
      <div className="fill-row">
        <button type="button" className="small" disabled={busy || uploading || changes.length === 0 || note.trim().length < 3} onClick={send}>
          {busy ? "Sending…" : uploading ? "Uploading…" : approver ? `Save ${changes.length || ""} change${changes.length === 1 ? "" : "s"}` : `Send ${changes.length || ""} change${changes.length === 1 ? "" : "s"} for approval`}</button>
        <button type="button" className="secondary small" onClick={() => { adds.reset(); close(); }}>Cancel</button>
      </div>
      {error && <span className="small" style={{ color: "var(--bad)" }}>{error}</span>}
    </>
  );
}
