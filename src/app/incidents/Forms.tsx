"use client";
import { useActionState, useState } from "react";
import { acknowledgeIr, closeIr, issueIr, type ActionState } from "./actions";

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


/** The employee acknowledges receiving the IR and writes their response. */
export function AckForm({ id }: { id: string }) {
  const [s, action, pending] = useActionState(acknowledgeIr, undefined);
  if (s?.ok) return <Msg s={s} />;
  return (
    <form action={action} className="field-grid no-print">
      <Msg s={s} />
      <input type="hidden" name="id" value={id} />
      <label className="check"><input type="checkbox" name="ack" value="yes" required /> I have read and received this incident report.</label>
      <label className="field">Your response<textarea name="response" rows={4} maxLength={2000} required /></label>
      <div className="field"><button disabled={pending}>{pending ? "Sending…" : "Acknowledge and send response"}</button></div>
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


