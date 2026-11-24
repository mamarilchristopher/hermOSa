"use client";
import { useActionState, useState } from "react";
import { closeIr, explainIr, issueIr, setLimit, type ActionState } from "./actions";

function Msg({ s }: { s: ActionState }) {
  if (s?.error) return <div className="notice error">{s.error}</div>;
  if (s?.ok) return <div className="notice ok">{s.ok}</div>;
  return null;
}

export function IssueForm({ id }: { id: string }) {
  const [s, action, pending] = useActionState(issueIr, undefined);
  const [dismiss, setDismiss] = useState(false);
  return (
    <form action={action} className="field-grid no-print">
      <Msg s={s} />
      <input type="hidden" name="id" value={id} />
      <label className="field">{dismiss ? "Why dismiss it?" : "Note to the employee (optional)"}
        <textarea name="note" rows={2} maxLength={1000} required={dismiss} /></label>
      <div className="field row-buttons">
        {dismiss ? (
          <><button name="decision" value="dismiss" className="danger" disabled={pending}>Dismiss IR</button>
            <button type="button" className="secondary" onClick={() => setDismiss(false)}>Back</button></>
        ) : (
          <><button name="decision" value="issue" disabled={pending}>{pending ? "Issuing…" : "Issue to employee"}</button>
            <button type="button" className="secondary" onClick={() => setDismiss(true)}>Dismiss</button></>
        )}
      </div>
    </form>
  );
}

export function ExplainForm({ id }: { id: string }) {
  const [s, action, pending] = useActionState(explainIr, undefined);
  return (
    <form action={action} className="field-grid no-print">
      <Msg s={s} />
      <input type="hidden" name="id" value={id} />
      <label className="field">Your explanation<textarea name="explanation" rows={4} maxLength={2000} required /></label>
      <div className="field"><button disabled={pending}>{pending ? "Sending…" : "Send explanation"}</button></div>
    </form>
  );
}

export function CloseForm({ id }: { id: string }) {
  const [s, action, pending] = useActionState(closeIr, undefined);
  return (
    <form action={action} className="field-grid no-print">
      <Msg s={s} />
      <input type="hidden" name="id" value={id} />
      <label className="field">Action taken<input name="action" maxLength={1000} required placeholder="e.g. Verbal warning, Written warning" /></label>
      <div className="field"><button disabled={pending}>{pending ? "Closing…" : "Close IR"}</button></div>
    </form>
  );
}

export function LimitForm({ minutes }: { minutes: number }) {
  const [s, action, pending] = useActionState(setLimit, undefined);
  return (
    <form action={action} className="row-buttons">
      <span className="small">Draft an IR when late minutes in a cutoff reach</span>
      <input name="minutes" type="number" min={1} max={1440} defaultValue={minutes} style={{ width: 90 }} />
      <span className="small">minutes</span>
      <button className="secondary small" disabled={pending}>Save</button>
      {s?.error && <span className="field-error">{s.error}</span>}
      {s?.ok && <span className="small ok-text">{s.ok}</span>}
    </form>
  );
}

export function PrintButton() {
  return <button type="button" className="secondary no-print" onClick={() => window.print()}>Print / Save as PDF</button>;
}
