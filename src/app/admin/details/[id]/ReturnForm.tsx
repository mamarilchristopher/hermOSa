"use client";
import { useActionState } from "react";
import { returnDetails } from "../actions";

export function ReturnForm({ submission }: { submission: string }) {
  const [state, action, pending] = useActionState(returnDetails, undefined);
  return (
    <form action={action} className="stack">
      <input type="hidden" name="submission" value={submission} />
      <label>What should they fix?<textarea name="note" rows={2} maxLength={500} required placeholder="e.g. Your SSS number is missing a digit." /></label>
      {state?.error && <div className="notice error">{state.error}</div>}
      <button type="submit" className="secondary" disabled={pending}>{pending ? "Sending…" : "Send back"}</button>
    </form>
  );
}
