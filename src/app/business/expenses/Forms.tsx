"use client";
// Expenses (update-0100): the add / edit form with receipt photos, used by "+ Add expense", the Due-this-month cards and Edit.
// v0.100.1 (CHRIS Nov 28): "Scan receipt or screenshot" reads the photo and fills the form (or a list, for handwritten
// ledgers and ride lists); every entry must name its branch (or Company-wide), suggested from the address on the receipt.
import { useState } from "react";
import { createClient } from "@/lib/supabase/browser";
import type { Scan, ScanItem } from "@/lib/receiptScan";
import { saveExpense, saveExpenses, voidExpense } from "./actions";
import { IconCamera, IconReceipt } from "@/components/Icons";

export type CatOpt = { id: string; name: string; grp: string };
export type BranchOpt = { id: string; name: string; code?: string };
/** branch_id: an id, null = Company-wide, undefined = not picked yet (the form then asks). */
export type Prefill = {
  id?: string; branch_id?: string | null; category_id?: string; spent_on?: string; amount?: string; description?: string; payee?: string | null; paid_via?: string | null;
  receipts?: { path: string; url?: string }[];
};
type Slot = { key: string; path?: string; preview?: string; name: string; status: "uploading" | "done" | "error" };
type Row = ScanItem & { key: string; on: boolean; amount: string; date: string };
type Reading = { status: "idle" | "reading" | "done" | "error"; msg?: string; tone?: "ok" | "warn" | "error" | "info"; scan?: Scan };

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "image/heif": "heif", "application/pdf": "pdf" };
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
  (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(c) / 4)))).toString(16)));
const GRP: Record<string, string> = { FIXED: "Monthly bills", PEOPLE: "People", CLINIC: "Clinic", BUSINESS: "Business" };
const VIA = [["CASH", "Cash"], ["BANK", "Bank transfer"], ["GCASH", "GCash"], ["CARD", "Card"], ["OTHER", "Other"]];
const peso = (cents: number) => (cents / 100).toFixed(2).replace(/\.00$/, "");
const php = (cents: number) => `₱${(cents / 100).toLocaleString("en-PH", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const SCAN_ERR: Record<string, string> = {
  NO_KEY: "Receipt reading isn't switched on yet (the owner adds the reading key once). Type the details for now; the receipt is attached.",
  BAD_KEY: "Receipt reading is switched off: the reading key was refused. Type the details for now; the receipt is attached.",
  BUSY: "The reader is busy. Try Scan again in a minute, or type the details.",
  NOT_READ: "Couldn't read this one. Type the details; the receipt is attached.",
  BAD_TYPE: "This file type can't be read. Take a screenshot or a JPG photo of it and scan that.",
  TOO_BIG: "This file is too big to read. Take a screenshot of it and scan that.",
  FORBIDDEN: "Only owners, the GM and Finance can scan receipts.",
  NEEDS_SQL: "The owner needs to run update-0100 in Supabase first.",
};

/** A smaller JPEG copy for reading (the receipt itself is kept as uploaded). Null when the browser can't open the photo. */
async function readableCopy(file: File): Promise<Blob | null> {
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) return file.size <= 20 * 1024 * 1024 ? new Blob([file], { type: "application/pdf" }) : null;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 2400 / Math.max(bmp.width, bmp.height), Math.sqrt(6_000_000 / (bmp.width * bmp.height)));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(bmp.width * scale)); c.height = Math.max(1, Math.round(bmp.height * scale));
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(bmp, 0, 0, c.width, c.height);
    for (const q of [0.85, 0.7, 0.55]) {
      const b = await new Promise<Blob | null>((ok) => c.toBlob(ok, "image/jpeg", q));
      if (b && b.size <= 4.5 * 1024 * 1024) return b;
    }
    return null;
  } catch {
    return ["image/jpeg", "image/png", "image/webp"].includes(file.type) && file.size <= 4.5 * 1024 * 1024 ? file : null;
  }
}

export function ExpenseForm({ org, cats, branches, prefill = {}, month, scope, today, submit = "Save expense" }: {
  org: string; cats: CatOpt[]; branches: BranchOpt[]; prefill?: Prefill; month: string; scope: string; today: string; submit?: string;
}) {
  const [slots, setSlots] = useState<Slot[]>(() => (prefill.receipts ?? []).map((r) => ({ key: r.path, path: r.path, preview: r.url, name: "Receipt", status: "done" as const })));
  const [fill, setFill] = useState<Prefill>(prefill);
  const [ver, setVer] = useState(0);
  const [unsure, setUnsure] = useState<Set<string>>(new Set());
  const [branch, setBranch] = useState(prefill.branch_id === undefined ? "" : prefill.branch_id ?? "company");
  const [reading, setReading] = useState<Reading>({ status: "idle" });
  const [rows, setRows] = useState<Row[] | null>(null);
  const patch = (key: string, p: Partial<Slot>) => setSlots((l) => l.map((s) => (s.key === key ? { ...s, ...p } : s)));

  const upload = async (file: File, key = uuid()) => {
    const ext = EXT[file.type] ?? (/\.(heic|heif|pdf|jpe?g|png|webp)$/i.test(file.name) ? file.name.split(".").pop()!.toLowerCase().replace("jpeg", "jpg") : null);
    if (!ext) return;
    setSlots((l) => [...l, { key, name: file.name, preview: ext === "pdf" ? undefined : URL.createObjectURL(file), status: "uploading" }]);
    const path = `${org}/${key}.${ext}`;
    const { error } = await createClient().storage.from("expense-receipts").upload(path, file, { contentType: file.type || (ext === "pdf" ? "application/pdf" : `image/${ext}`) });
    patch(key, error ? { status: "error" } : { status: "done", path });
  };
  const add = async (files: FileList | null) => {
    for (const file of Array.from(files ?? []).slice(0, Math.max(0, 5 - slots.length))) await upload(file);
  };

  const apply = (scan: Scan, slot: string) => {
    if (scan.branch_id && !branch) setBranch(scan.branch_id);
    if (scan.not_expense) {
      setSlots((l) => l.filter((x) => x.key !== slot));
      setReading({ status: "done", tone: "warn", scan, msg: "This looks like a sales invoice (money coming in), not an expense, so nothing was filled and the photo was not attached. Sales go in the Service log." });
      return;
    }
    if (!scan.items.length) { setReading({ status: "done", tone: "warn", scan, msg: scan.note || SCAN_ERR.NOT_READ }); return; }
    if (scan.items.length === 1) {
      const it = scan.items[0];
      setFill((f) => ({ ...f, amount: peso(it.amount_cents), spent_on: it.spent_on ?? f.spent_on ?? today, description: it.description,
        category_id: it.category_id ?? f.category_id, payee: scan.payee ?? f.payee, paid_via: scan.paid_via ?? f.paid_via }));
      setUnsure(new Set([...(it.unsure ? ["amount", "date"] : []), ...(it.spent_on ? [] : ["date"]), ...(it.category_id ? [] : ["category"])]));
      setVer((v) => v + 1);
      setRows(null);
      setReading({ status: "done", tone: it.dup ? "warn" : "ok", scan,
        msg: it.dup ? `Maybe already entered: ${it.dup.description} (${it.dup.spent_on}, same amount). Check before saving.`
          : `Filled from the receipt${it.unsure ? ". Some of it was hard to read" : ""}. Check it, then save.` });
      return;
    }
    let last = today;
    setRows(scan.items.map((it) => {
      if (it.spent_on) last = it.spent_on;
      return { ...it, key: uuid(), on: !it.dup, amount: peso(it.amount_cents), date: it.spent_on ?? last, unsure: it.unsure || !it.spent_on };
    }));
    setReading({ status: "done", tone: "ok", scan, msg: `Found ${scan.items.length} expenses on this receipt (${php(scan.total_cents)}). Untick any that shouldn't be saved.` });
  };

  const scanFile = async (file: File | undefined) => {
    if (!file) return;
    setReading({ status: "reading" });
    const copy = readableCopy(file);
    const slot = uuid();
    if (slots.length < 5) void upload(file, slot);
    const blob = await copy;
    if (!blob) { setReading({ status: "error", tone: "error", msg: SCAN_ERR.BAD_TYPE }); return; }
    const body = new FormData();
    body.set("file", blob, file.name);
    body.set("name", file.name);
    try {
      const res = await fetch("/api/expenses/scan", { method: "POST", body });
      const j = (await res.json()) as { ok: boolean; error?: string; scan?: Scan };
      if (!j.ok || !j.scan) { setReading({ status: "error", tone: j.error === "NO_KEY" ? "info" : "error", msg: SCAN_ERR[j.error ?? ""] ?? "Couldn't read it. Try again, or type the details." }); return; }
      apply(j.scan, slot);
    } catch {
      setReading({ status: "error", tone: "error", msg: "No connection. Try Scan again, or type the details." });
    }
  };

  const uploading = slots.some((s) => s.status === "uploading");
  const groups = Object.keys(GRP).map((g) => [g, cats.filter((c) => c.grp === g)] as const).filter(([, l]) => l.length);
  const catSelect = (name: string, value: string | null | undefined, onChange?: (v: string) => void, cls?: string) => (
    <select name={name} required defaultValue={onChange ? undefined : value ?? ""} value={onChange ? value ?? "" : undefined} className={cls}
      onChange={onChange ? (e) => onChange(e.target.value) : undefined} aria-label="Category">
      <option value="" disabled>Pick one</option>
      {groups.map(([g, l]) => <optgroup key={g} label={GRP[g]}>{l.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</optgroup>)}
    </select>
  );
  const chk = (k: string) => (unsure.has(k) ? " exp-check" : "");
  const on = rows?.filter((r) => r.on) ?? [];
  const onTotal = on.reduce((s, r) => s + Math.round(Number(r.amount.replace(/,/g, "")) * 100 || 0), 0);
  const setRow = (key: string, p: Partial<Row>) => setRows((l) => l && l.map((r) => (r.key === key ? { ...r, ...p } : r)));
  const branchName = reading.scan?.branch_name;

  return (
    <form action={rows ? saveExpenses : saveExpense} className="exp-form">
      <input type="hidden" name="month" value={month} />
      <input type="hidden" name="scope" value={scope} />
      {prefill.id && <input type="hidden" name="id" value={prefill.id} />}
      <input type="hidden" name="receipts" value={JSON.stringify(slots.filter((s) => s.status === "done").map((s) => s.path))} />
      {rows && <input type="hidden" name="rows" value={JSON.stringify(on.map((r) => ({ spent_on: r.date, amount: r.amount, description: r.description, category_id: r.category_id })))} />}

      {!prefill.id && (
        <div className="exp-scan">
          <label className={`button exp-scan-btn${reading.status === "reading" ? " busy" : ""}`}>
            <input type="file" accept="image/*,.heic,.heif,application/pdf" hidden disabled={reading.status === "reading"}
              onChange={(e) => { void scanFile(e.target.files?.[0]); e.target.value = ""; }} />
            <IconCamera />{reading.status === "reading" ? "Reading the receipt…" : reading.status === "idle" ? "Scan receipt or screenshot" : "Scan another"}
          </label>
          <span className="small muted">Bills, store receipts, GCash or app screenshots, vouchers, handwritten lists. It fills the details; you check and save.</span>
        </div>
      )}
      {reading.msg && <div className={`notice ${reading.tone ?? "info"} exp-scan-msg`}>{reading.msg}{reading.scan?.note && reading.scan.items.length > 0 ? <span className="small"> {reading.scan.note}</span> : null}</div>}

      <label className={`field exp-pick-branch${branch ? "" : " exp-check"}`}><span className="field-label">Branch this is for</span>
        <select name="branch_id" required value={branch} onChange={(e) => setBranch(e.target.value)}>
          <option value="" disabled>Pick the branch</option>
          {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          <option value="company">Company-wide (shared by all branches)</option>
        </select>
        {branchName && branch === reading.scan?.branch_id && <span className="small muted">From the receipt{reading.scan?.branch_reason ? `: ${reading.scan.branch_reason}` : ""}. Change it if it's wrong.</span>}
        {!branch && <span className="small muted">Every expense is recorded under one branch, or Company-wide for shared costs.</span>}
      </label>

      {rows ? (
        <div className="exp-rows">
          {rows.map((r) => (
            <div key={r.key} className={`exp-row${r.on ? "" : " off"}${r.unsure ? " unsure" : ""}`}>
              <label className="exp-row-on"><input type="checkbox" checked={r.on} onChange={(e) => setRow(r.key, { on: e.target.checked })} aria-label="Save this one" /></label>
              <input type="date" value={r.date} max={today} required={r.on} disabled={!r.on} onChange={(e) => setRow(r.key, { date: e.target.value })} aria-label="Date paid" />
              <input value={r.description} required={r.on} disabled={!r.on} minLength={2} maxLength={120} onChange={(e) => setRow(r.key, { description: e.target.value })} aria-label="What was it for" />
              {r.on ? catSelect("", r.category_id, (v) => setRow(r.key, { category_id: v })) : <span className="small muted">Not saved</span>}
              <input className="exp-row-amt" inputMode="decimal" value={r.amount} required={r.on} disabled={!r.on} pattern="[0-9,]+(\.[0-9]{1,2})?"
                onChange={(e) => setRow(r.key, { amount: e.target.value })} aria-label="Amount" />
              {(r.dup || r.unsure) && <span className="exp-row-tag small">{r.dup ? `Maybe already entered: ${r.dup.description}, ${r.dup.spent_on}` : "Hard to read: check date and amount"}</span>}
            </div>
          ))}
          <div className="exp-grid">
            <label className="field"><span className="field-label">Paid via <span className="muted">(optional)</span></span>
              <select name="paid_via" defaultValue={reading.scan?.paid_via ?? ""}><option value="">—</option>{VIA.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
            <label className="field exp-wide"><span className="field-label">Paid to <span className="muted">(optional, for all)</span></span>
              <input name="payee" maxLength={80} defaultValue={reading.scan?.payee ?? ""} placeholder="Supplier, rider app, staff who got the cash" /></label>
          </div>
          <div className="exp-rows-foot">
            <button type="submit" disabled={uploading || !on.length || !branch}>{uploading ? "Uploading receipt…" : !branch ? "Pick the branch first" : `Save ${on.length} expense${on.length === 1 ? "" : "s"} (${php(onTotal)})`}</button>
            <button type="button" className="secondary small" onClick={() => {
              setFill((f) => ({ ...f, amount: peso(onTotal), description: f.description ?? (reading.scan?.payee ? `${reading.scan.payee} expenses` : ""), spent_on: on[on.length - 1]?.date ?? today,
                category_id: on.find((r) => r.category_id)?.category_id ?? f.category_id, payee: reading.scan?.payee ?? f.payee, paid_via: reading.scan?.paid_via ?? f.paid_via }));
              setRows(null); setVer((v) => v + 1); setReading((x) => ({ ...x, msg: "Recorded as one total. Check it, then save.", tone: "ok" }));
            }}>Save as one total instead</button>
          </div>
        </div>
      ) : (
        <>
          <div className="exp-grid" key={ver}>
            <label className="field"><span className="field-label">What was it for?</span>
              <input name="description" required minLength={2} maxLength={120} defaultValue={fill.description} placeholder="e.g. Rent, December" /></label>
            <label className={`field${chk("amount")}`}><span className="field-label">Amount (₱)</span>
              <input name="amount" required inputMode="decimal" pattern="[0-9,]+(\.[0-9]{1,2})?" defaultValue={fill.amount} placeholder="0" /></label>
            <label className={`field${chk("category")}`}><span className="field-label">Category</span>{catSelect("category_id", fill.category_id)}</label>
            <label className={`field${chk("date")}`}><span className="field-label">Date paid</span>
              <input type="date" name="spent_on" required defaultValue={fill.spent_on ?? today} max={today} /></label>
            <label className="field"><span className="field-label">Paid via <span className="muted">(optional)</span></span>
              <select name="paid_via" defaultValue={fill.paid_via ?? ""}><option value="">—</option>{VIA.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
            <label className="field"><span className="field-label">Paid to <span className="muted">(optional)</span></span>
              <input name="payee" maxLength={80} defaultValue={fill.payee ?? ""} placeholder="Supplier, landlord, utility" /></label>
          </div>
        </>
      )}

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
              <IconReceipt />Add receipt
            </label>
          )}
        </div>
      </div>
      {!rows && <button type="submit" disabled={uploading || !branch}>{uploading ? "Uploading receipt…" : !branch ? "Pick the branch first" : submit}</button>}
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
