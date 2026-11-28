"use client";
import Link from "next/link";
import { useActionState, useEffect, useRef, useState, type MouseEvent } from "react";
import { createClient } from "@/lib/supabase/browser";
import { nteDeadline } from "@/lib/nte";
import { explainNte, issueLateIr, pingNte, reviewNte, voidNte, type ActionState } from "./actions";
import { pick } from "@/lib/decision";
import { IconBell, IconX } from "@/components/Icons";

function Msg({ s }: { s: ActionState }) {
  if (s?.error) return <div className="notice error">{s.error}</div>;
  if (s?.ok) return <div className="notice ok">{s.ok}</div>;
  return null;
}

/** Time left to explain (update-0032), counting down live; or the automatic IR once it's issued. */
export function NteDeadline({ n }: { n: { respond_by?: string | null; ir_id?: string | null } }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  if (n.ir_id) return <p className="small nte-deadline over" style={{ margin: 0 }}>Not explained within 2 working days, so an IR was issued. <Link href={`/incidents/${n.ir_id}`}>Open the IR</Link>. You can still write your explanation below.</p>;
  const d = nteDeadline(n.respond_by, now);
  return <p className={`small nte-deadline${d.urgent ? " over" : ""}`} style={{ margin: 0 }} suppressHydrationWarning><strong>{d.text}</strong></p>;
}

/** The employee's explanation box. Shown on Home, the time clock and My Late NTEs until it's answered. */
const PROOF_EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "image/heif": "heif" };
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
  (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (Number(c) / 4)))).toString(16)));
type Proof = { key: string; preview: string; path?: string; status: "uploading" | "done" | "error" };

/**
 * The employee's explanation box. Shown on Home, the time clock and My Late NTEs until it's answered.
 * CHRIS Nov 26 (update-0065): a photo proof is required (1 to 3 photos, uploaded as picked, original file).
 */
export function NteExplainForm({ id, prompt }: { id: string; prompt: string }) {
  const [s, action, pending] = useActionState(explainNte, undefined);
  const [proofs, setProofs] = useState<Proof[]>([]);
  const pickRef = useRef<HTMLInputElement>(null);
  if (s?.ok) return <Msg s={s} />;
  const done = proofs.filter((p) => p.status === "done");
  const uploading = proofs.some((p) => p.status === "uploading");
  const add = async (files: FileList | null) => {
    for (const file of Array.from(files ?? []).slice(0, 3 - proofs.length)) {
      const ext = PROOF_EXT[file.type] ?? (/\.(heic|heif)$/i.test(file.name) ? file.name.split(".").pop()!.toLowerCase() : null);
      if (!ext) { alert("Only photos or screenshots (JPG, PNG, WEBP or HEIC) can be added."); continue; }
      const key = uuid();
      setProofs((l) => [...l, { key, preview: URL.createObjectURL(file), status: "uploading" }]);
      const path = `${id}/${key}.${ext}`;
      const { error } = await createClient().storage.from("nte-proofs").upload(path, file, { contentType: file.type || `image/${ext}` });
      setProofs((l) => l.map((p) => (p.key === key ? { ...p, status: error ? "error" : "done", path } : p)));
    }
  };
  const remove = (key: string) => setProofs((l) => { const p = l.find((x) => x.key === key); if (p) URL.revokeObjectURL(p.preview); return l.filter((x) => x.key !== key); });
  return (
    <form action={action} className="field-grid">
      <Msg s={s} />
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="proof" value={JSON.stringify(done.map((p) => p.path))} />
      <label className="field">{prompt}
        <textarea name="explanation" rows={3} maxLength={2000} required placeholder="Example: Heavy traffic on Commonwealth Ave." /></label>
      <div className="field nte-proof">
        <span className="field-label">Photo proof <span className="muted">(required)</span></span>
        <ul className="small muted nte-proof-help">
          <li><strong>Heavy traffic:</strong> a photo of the traffic.</li>
          <li><strong>Hirap mag-book (hard to book a ride):</strong> a screenshot of your ride app booking made <strong>before 10 AM</strong>, with the time showing.</li>
        </ul>
        <div className="nte-proof-row">
          {proofs.map((p) => (
            <span key={p.key} className={`nte-proof-thumb ${p.status}`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={p.preview} alt="Proof photo" />
              <span className="nte-proof-status">{p.status === "uploading" ? "Uploading…" : p.status === "error" ? "Didn't upload" : "✓"}</span>
              <button type="button" className="nte-proof-x" aria-label="Remove photo" onClick={() => remove(p.key)}><IconX size={14} /></button>
            </span>
          ))}
          {proofs.length < 3 && (
            <button type="button" className="nte-proof-add" onClick={() => pickRef.current?.click()}><span aria-hidden>+</span> Add photo</button>
          )}
          <input ref={pickRef} type="file" accept="image/*" multiple hidden onChange={(e) => { void add(e.target.files); e.target.value = ""; }} />
        </div>
      </div>
      <div className="field"><button disabled={pending || uploading || done.length === 0}>{pending ? "Sending…" : uploading ? "Uploading photo…" : "Send explanation"}</button>
        {done.length === 0 && !uploading && <span className="small muted"> Add a photo to send.</span>}</div>
    </form>
  );
}

/** Proof photos on an explained NTE (signed links made by the page). */
export function NteProofs({ urls }: { urls: string[] }) {
  if (!urls.length) return null;
  return (
    <div className="nte-proof-row">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {urls.map((u, i) => <a key={u} href={u} target="_blank" rel="noreferrer" className="nte-proof-thumb done"><img src={u} alt={`Proof photo ${i + 1}`} /></a>)}
    </div>
  );
}

/** Management (update-0067): accept the reason (it stops counting toward an IR) or reject it (it keeps counting). */
/** CHRIS (Nov 26): default note, still editable. Untouched, Reject sends the reject wording instead. */
export const NTE_ACCEPT_NOTE = "Adjust accordingly next time. NTE Accepted.";
export const NTE_REJECT_NOTE = "Reason not accepted. This Late NTE counts toward an IR.";

export function ReviewNteForm({ id, current }: { id: string; current?: "ACCEPTED" | "REJECTED" | null }) {
  const [s, action, pending] = useActionState(reviewNte, undefined);
  const [note, setNote] = useState(NTE_ACCEPT_NOTE);
  const onReject = (e: MouseEvent<HTMLButtonElement>) => {
    if (note === NTE_ACCEPT_NOTE) { setNoteNow(e.currentTarget.form, NTE_REJECT_NOTE); setNote(NTE_REJECT_NOTE); }
    pick("reject")(e);
  };
  return (
    <form action={action} className="nte-review">
      <input type="hidden" name="id" value={id} />
      <input name="note" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note to the employee (optional)" aria-label="Note to the employee" />
      <div className="row-buttons">
        {current !== "ACCEPTED" && <button className="small" disabled={pending} onClick={pick("accept")}>Accept reason</button>}
        {current !== "REJECTED" && <button className="danger small" disabled={pending} onClick={onReject}>Reject reason</button>}
      </div>
      {s?.error && <span className="field-error">{s.error}</span>}
      {s?.ok && <span className="small ok-text">{s.ok}</span>}
    </form>
  );
}

/** Sets the note field before the form submits (React state would update too late for this submit). */
function setNoteNow(form: HTMLFormElement | null, text: string) {
  const el = form?.elements.namedItem("note");
  if (el instanceof HTMLInputElement) el.value = text;
}

/** Management: cancel an NTE that was a mistake (wrong schedule, approved errand). */
/** CHRIS Nov 27 (update-0094): remind the employee to explain. Sends a notification and a Hermosapp push. */
export function PingNteButton({ id, name, count, last }: { id: string; name: string; count?: number; last?: string | null }) {
  const [s, action, pending] = useActionState(pingNte, undefined);
  const when = last ? new Intl.DateTimeFormat("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(last)) : null;
  return (
    <form action={action} className="nte-ping">
      <input type="hidden" name="id" value={id} />
      <button className="small" disabled={pending} title={`Send ${name} a reminder to explain`}><IconBell />{pending ? "Sending…" : `Ping ${name}`}</button>
      {s?.ok ? <span className="small ok-text">{s.ok}</span>
        : s?.error ? <span className="field-error">{s.error}</span>
        : count ? <span className="small muted">Reminded {count === 1 ? "once" : `${count} times`}{when ? `, last ${when}` : ""}</span> : null}
    </form>
  );
}

export function VoidNteForm({ id }: { id: string }) {
  const [s, action, pending] = useActionState(voidNte, undefined);
  const [open, setOpen] = useState(false);
  if (s?.ok) return <span className="small ok-text">{s.ok}</span>;
  if (!open) return <button type="button" className="secondary small" onClick={() => setOpen(true)}>Doesn&apos;t count</button>;
  return (
    <form action={action} className="row-buttons">
      <input type="hidden" name="id" value={id} />
      <input name="reason" maxLength={500} required placeholder="Why it doesn't count (e.g. wrong schedule)" style={{ minWidth: 220 }} />
      <button className="danger small" disabled={pending}>Cancel NTE</button>
      <button type="button" className="secondary small" onClick={() => setOpen(false)}>Back</button>
      {s?.error && <span className="field-error">{s.error}</span>}
    </form>
  );
}

/** "Issue an IR?" Yes opens the note box and the button. */
export function IssueLateIrForm({ employee, month, question }: { employee: string; month: string; question: string }) {
  const [s, action, pending] = useActionState(issueLateIr, undefined);
  const [yes, setYes] = useState(false);
  return (
    <div className="nte-ask">
      <p><strong>{question}</strong></p>
      {!yes ? (
        <div className="row-buttons">
          <button type="button" onClick={() => setYes(true)}>Yes, issue an IR</button>
          <span className="small muted">or leave it for now</span>
        </div>
      ) : (
        <form action={action} className="field-grid">
          <Msg s={s} />
          <input type="hidden" name="employee" value={employee} />
          <input type="hidden" name="month" value={month} />
          <label className="field">Note to the employee (optional)<textarea name="note" rows={2} maxLength={1000} /></label>
          <div className="field row-buttons">
            <button disabled={pending}>{pending ? "Issuing…" : "Issue IR now"}</button>
            <button type="button" className="secondary" onClick={() => setYes(false)}>Back</button>
          </div>
          <p className="small muted">They get an urgent notice on their Home to acknowledge it and respond. The IR is saved as a PDF.</p>
        </form>
      )}
    </div>
  );
}
