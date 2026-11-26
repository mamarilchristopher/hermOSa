"use client";
// Proof of payment (update-0075, CHRIS Nov 26): optional screenshots or photos of a payment (usually online transfers).
// Kept in their own private folder ("payment-proofs") and listed in Clinic > Proof of payment by service date and client.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/browser";
import { thumbOf } from "./PhotoSlots";

type Slot = { key: string; preview: string; path?: string; thumb?: string | null; status: "uploading" | "done" | "error" };
const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "image/heif": "heif" };
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
  (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(c) / 4)))).toString(16)));
export const MAX_PROOFS = 5;

export function useProofSlots(branch: string) {
  const [folder, setFolder] = useState(uuid);
  const [slots, setSlots] = useState<Slot[]>([]);
  const patch = (key: string, p: Partial<Slot>) => setSlots((l) => l.map((s) => (s.key === key ? { ...s, ...p } : s)));
  const add = async (files: FileList | null, room = MAX_PROOFS) => {
    for (const file of Array.from(files ?? []).slice(0, Math.max(0, room - slots.length))) {
      const ext = EXT[file.type] ?? (/\.(heic|heif)$/i.test(file.name) ? file.name.split(".").pop()!.toLowerCase() : null);
      if (!ext) continue;
      const key = uuid();
      setSlots((l) => [...l, { key, preview: URL.createObjectURL(file), status: "uploading" }]);
      const sb = createClient();
      const path = `${branch}/${folder}/proof-${key}.${ext}`;
      const { error } = await sb.storage.from("payment-proofs").upload(path, file, { contentType: file.type || `image/${ext}` });
      if (error) { patch(key, { status: "error" }); continue; }
      let thumb: string | null = null;
      const t = await thumbOf(file);
      if (t) {
        const tp = `${branch}/${folder}/thumb-${key}.jpg`;
        if (!(await sb.storage.from("payment-proofs").upload(tp, t, { contentType: "image/jpeg" })).error) thumb = tp;
      }
      patch(key, { status: "done", path, thumb });
    }
  };
  const remove = (key: string) => setSlots((l) => { const s = l.find((x) => x.key === key); if (s) URL.revokeObjectURL(s.preview); return l.filter((x) => x.key !== key); });
  const reset = () => { slots.forEach((s) => URL.revokeObjectURL(s.preview)); setSlots([]); setFolder(uuid()); };
  const json = JSON.stringify(slots.filter((s) => s.status === "done").map((s) => ({ path: s.path, thumb: s.thumb ?? null })));
  return { slots, add, remove, reset, json, uploading: slots.some((s) => s.status === "uploading") };
}
type Api = ReturnType<typeof useProofSlots>;

/** The "Attach proof of payment" button and the picked files (Add a service form and on an entry). */
export function ProofGroup({ api, room = MAX_PROOFS, hint = true }: { api: Api; room?: number; hint?: boolean }) {
  return (
    <div className="field photo-group">
      <span className="field-label">Proof of payment <span className="muted">(optional)</span></span>
      {hint && <span className="small muted">For online transfers: a screenshot of the GCash / bank transfer, or a photo of the receipt.</span>}
      <div className="photo-row">
        {api.slots.map((s) => (
          <figure key={s.key} className={`photo-slot ${s.status}`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={s.preview} alt="Proof of payment" />
            <figcaption>{s.status === "uploading" ? "Uploading…" : s.status === "error" ? "Didn't upload" : "Proof"}</figcaption>
            <button type="button" className="photo-x" aria-label="Remove" onClick={() => api.remove(s.key)}>×</button>
          </figure>
        ))}
        {api.slots.length < room && (
          <label className="photo-add proof-add">
            <input type="file" accept="image/*,.heic,.heif" multiple hidden onChange={(e) => { void api.add(e.target.files, room); e.target.value = ""; }} />
            <span aria-hidden>💳</span>Attach proof of payment
          </label>
        )}
      </div>
    </div>
  );
}

/** On a saved entry: attach proof later. */
export function AttachProof({ log, branch, have }: { log: string; branch: string; have: number }) {
  const router = useRouter();
  const api = useProofSlots(branch);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (have >= MAX_PROOFS) return null;
  if (!open) return <button type="button" className="link-like small proof-link" onClick={() => setOpen(true)}>💳 Attach proof of payment</button>;
  const save = async () => {
    setBusy(true); setError(null);
    const { data, error: e } = await createClient().rpc("add_payment_proof", { p_log: log, p_photos: JSON.parse(api.json) });
    setBusy(false);
    if (e?.code === "PGRST202") { setError("Proof of payment needs database update-0075 first."); return; }
    if (e || !data?.ok) { setError(data?.error === "TOO_MANY" ? `At most ${MAX_PROOFS} proofs per entry.` : data?.error === "PHOTO_NOT_UPLOADED" ? "A file didn't finish uploading. Remove it and add it again." : "Could not save. Try again."); return; }
    api.reset(); setOpen(false); router.refresh();
  };
  return (
    <div className="add-later">
      <ProofGroup api={api} room={MAX_PROOFS - have} hint={false} />
      <div className="fill-row">
        <button type="button" className="small" disabled={busy || api.uploading || !api.slots.some((s) => s.status === "done")} onClick={save}>
          {busy ? "Saving…" : api.uploading ? "Uploading…" : "Save proof"}</button>
        <button type="button" className="secondary small" onClick={() => { api.reset(); setOpen(false); }}>Cancel</button>
      </div>
      {error && <span className="small" style={{ color: "var(--bad)" }}>{error}</span>}
    </div>
  );
}
