"use client";
import Link from "next/link";
import { useActionState, useEffect, useState } from "react";
import { nteDeadline } from "@/lib/nte";
import { explainNte, issueLateIr, voidNte, type ActionState } from "./actions";

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
export function NteExplainForm({ id, prompt }: { id: string; prompt: string }) {
  const [s, action, pending] = useActionState(explainNte, undefined);
  if (s?.ok) return <Msg s={s} />;
  return (
    <form action={action} className="field-grid">
      <Msg s={s} />
      <input type="hidden" name="id" value={id} />
      <label className="field">{prompt}
        <textarea name="explanation" rows={3} maxLength={2000} required placeholder="Example: Heavy traffic on Commonwealth Ave." /></label>
      <div className="field"><button disabled={pending}>{pending ? "Sending…" : "Send explanation"}</button></div>
    </form>
  );
}

/** Management: cancel an NTE that was a mistake (wrong schedule, approved errand). */
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
