"use client";
// Expenses (update-0100): the add / edit form with receipt photos, used by "+ Add expense", the Due-this-month cards and Edit.
import { useState } from "react";
import { createClient } from "@/lib/supabase/browser";
import { saveExpense, voidExpense } from "./actions";

export type CatOpt = { id: string; name: string; grp: string };
export type BranchOpt = { id: string; name: string; code?: string };
export type Prefill = {
  id?: string; branch_id?: string | null; category_id?: string; spent_on?: string; amount?: string; description?: string; payee?: string | null; paid_via?: string | null;
  receipts?: { path: string; url?: string }[];
};
type Slot = { key: string; path?: string; preview?: string; name: string; status: "uploading" | "done" | "error" };

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "image/heif": "heif", "application/pdf": "pdf" };
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
  (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(c) / 4)))).toString(16)));
const GRP: Record<string, string> = { FIXED: "Monthly bills", PEOPLE: "People", CLINIC: "Clinic", BUSINESS: "Business" };
const VIA = [["CASH", "Cash"], ["BANK", "Bank transfer"], ["GCASH", "GCash"], ["CARD", "Card"], ["OTHER", "Other"]];

export function ExpenseForm({ org, cats, branches, prefill = {}, month, scope, today, submit = "Save expense" }: {
  org: string; cats: CatOpt[]; branches: BranchOpt[]; prefill?: Prefill; month: string; scope: string; today: string; submit?: string;
}) {
  const [slots, setSlots] = useState<Slot[]>(() => (prefill.receipts ?? []).map((r) => ({ key: r.path, path: r.path, preview: r.url, name: "Receipt", status: "done" as const })));
  const patch = (key: string, p: Partial<Slot>) => setSlots((l) => l.map((s) => (s.key === key ? { ...s, ...p } : s)));
  const add = async (files: FileList | null) => {
    for (const file of Array.from(files ?? []).slice(0, Math.max(0, 5 - slots.length))) {
      const ext = EXT[file.type] ?? (/\.(heic|heif|pdf)$/i.test(file.name) ? file.name.split(".").pop()!.toLowerCase() : null);
      if (!ext) continue;
      const key = uuid();
      setSlots((l) => [...l, { key, name: file.name, preview: ext === "pdf" ? undefined : URL.createObjectURL(file), status: "uploading" }]);
      const path = `${org}/${key}.${ext}`;
      const { error } = await createClient().storage.from("expense-receipts").upload(path, file, { contentType: file.type || (ext === "pdf" ? "application/pdf" : `image/${ext}`) });
      patch(key, error ? { status: "error" } : { status: "done", path });
    }
  };
  const uploading = slots.some((s) => s.status === "uploading");
  const groups = Object.keys(GRP).map((g) => [g, cats.filter((c) => c.grp === g)] as const).filter(([, l]) => l.length);
  return (
    <form action={saveExpense} className="exp-form">
      <input type="hidden" name="month" value={month} />
      <input type="hidden" name="scope" value={scope} />
      {prefill.id && <input type="hidden" name="id" value={prefill.id} />}
      <input type="hidden" name="receipts" value={JSON.stringify(slots.filter((s) => s.status === "done").map((s) => s.path))} />
      <div className="exp-grid">
        <label className="field"><span className="field-label">What was it for?</span>
          <input name="description" required minLength={2} maxLength={120} defaultValue={prefill.description} placeholder="e.g. Rent, December" /></label>
        <label className="field"><span className="field-label">Amount (₱)</span>
          <input name="amount" required inputMode="decimal" pattern="[0-9,]+(\.[0-9]{1,2})?" defaultValue={prefill.amount} placeholder="0" /></label>
        <label className="field"><span className="field-label">Category</span>
          <select name="category_id" required defaultValue={prefill.category_id ?? ""}>
            <option value="" disabled>Pick one</option>
            {groups.map(([g, l]) => <optgroup key={g} label={GRP[g]}>{l.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</optgroup>)}
          </select></label>
        <label className="field"><span className="field-label">Branch</span>
          <select name="branch_id" defaultValue={prefill.branch_id ?? ""}>
            <option value="">Company-wide (shared)</option>
            {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select></label>
        <label className="field"><span className="field-label">Date paid</span>
          <input type="date" name="spent_on" required defaultValue={prefill.spent_on ?? today} max={today} /></label>
        <label className="field"><span className="field-label">Paid via <span className="muted">(optional)</span></span>
          <select name="paid_via" defaultValue={prefill.paid_via ?? ""}><option value="">—</option>{VIA.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        <label className="field exp-wide"><span className="field-label">Paid to <span className="muted">(optional)</span></span>
          <input name="payee" maxLength={80} defaultValue={prefill.payee ?? ""} placeholder="Supplier, landlord, utility" /></label>
      </div>
      <div className="field photo-group">
        <span className="field-label">Receipts <span className="muted">(optional, photos or PDF, up to 5)</span></span>
        <div className="photo-row">
          {slots.map((s) => (
            <figure key={s.key} className={`photo-slot ${s.status}`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {s.preview ? <img src={s.preview} alt="Receipt" /> : <span className="exp-pdf">PDF</span>}
              <figcaption>{s.status === "uploading" ? "Uploading…" : s.status === "error" ? "Didn't upload" : "Receipt"}</figcaption>
              <button type="button" className="photo-x" aria-label="Remove" onClick={() => setSlots((l) => l.filter((x) => x.key !== s.key))}>×</button>
            </figure>
          ))}
          {slots.length < 5 && (
            <label className="photo-add">
              <input type="file" accept="image/*,.heic,.heif,application/pdf" multiple hidden onChange={(e) => { void add(e.target.files); e.target.value = ""; }} />
              <span aria-hidden>🧾</span>Add receipt
            </label>
          )}
        </div>
      </div>
      <button type="submit" disabled={uploading}>{uploading ? "Uploading receipt…" : submit}</button>
    </form>
  );
}

/** Remove an expense typed by mistake (kept in the records with the reason). */
export function RemoveExpense({ id, month, scope }: { id: string; month: string; scope: string }) {
  const [open, setOpen] = useState(false);
  if (!open) return <button type="button" className="secondary small" onClick={() => setOpen(true)}>Remove</button>;
  return (
    <form action={voidExpense} className="exp-remove">
      <input type="hidden" name="id" value={id} /><input type="hidden" name="month" value={month} /><input type="hidden" name="scope" value={scope} />
      <input name="reason" required minLength={3} maxLength={200} placeholder="Why remove it? e.g. typed twice" />
      <button type="submit" className="danger small">Remove</button>
      <button type="button" className="secondary small" onClick={() => setOpen(false)}>Cancel</button>
    </form>
  );
}
