"use client";
import { useActionState } from "react";
import { decideCorrection } from "./actions";

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
