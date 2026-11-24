"use client";
import { useActionState, useState } from "react";
import { correctDay, decideCorrection, enterDay } from "./actions";

export function EnterForm({ branch, date }: { branch: string; date: string }) {
  const [state, action, pending] = useActionState(enterDay, undefined);
  if (state?.ok) return <div className="notice ok small">{state.ok}</div>;
  return (
    <form action={action} className="day-entry">
      <input type="hidden" name="branch" value={branch} />
      <input type="hidden" name="date" value={date} />
      <label className="money"><span>₱</span><input name="amount" inputMode="decimal" placeholder="Day's total" aria-label="Day's total" required autoComplete="off" /></label>
      <button type="submit" disabled={pending}>{pending ? "Saving…" : "Save"}</button>
      {state?.error && <div className="field-error">{state.error}</div>}
    </form>
  );
}

export function CorrectForm({ branch, date, current }: { branch: string; date: string; current: string }) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(correctDay, undefined);
  if (state?.ok) return <div className="notice ok small">{state.ok}</div>;
  if (!open) return <button type="button" className="secondary small" onClick={() => setOpen(true)}>Correct</button>;
  return (
    <form action={action} className="stack correct-form" key={state?.n ?? 0}>
      <input type="hidden" name="branch" value={branch} />
      <input type="hidden" name="date" value={date} />
      <label>Correct total (now {current})
        <span className="money"><span>₱</span><input name="amount" inputMode="decimal" required autoComplete="off" /></span></label>
      <label>Why? <input name="reason" minLength={8} maxLength={500} required placeholder="e.g. GCash payment was left out" /></label>
      {state?.error && <div className="field-error">{state.error}</div>}
      <div className="row-buttons">
        <button type="submit" disabled={pending}>{pending ? "Saving…" : "Save correction"}</button>
        <button type="button" className="secondary" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </form>
  );
}

export function DecideForm({ id, mine }: { id: string; mine: boolean }) {
  const [state, action, pending] = useActionState(decideCorrection, undefined);
  if (state?.ok) return <span className="small saved-tick">{state.ok}</span>;
  return (
    <form action={action} className="row-buttons" key={state?.n ?? 0}>
      <input type="hidden" name="id" value={id} />
      <input name="note" placeholder="Note (needed to reject)" maxLength={500} />
      <button type="submit" name="decision" value="approve" disabled={pending || mine} title={mine ? "Someone else has to approve your own request" : undefined}>Approve</button>
      <button type="submit" name="decision" value="reject" className="secondary" disabled={pending}>Reject</button>
      {state?.error && <span className="field-error">{state.error}</span>}
    </form>
  );
}
