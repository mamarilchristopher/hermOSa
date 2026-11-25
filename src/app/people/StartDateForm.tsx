"use client";
import { useActionState } from "react";
import { setStartDate } from "./actions";

/** Owners and the General Manager override a staff member's start date. */
export function StartDateForm({ id, date }: { id: string; date: string | null }) {
  const [state, action, pending] = useActionState(setStartDate, undefined);
  return (
    <form action={action} className="stack wide">
      <input type="hidden" name="id" value={id} />
      <div className="entry-grid">
        <label>Start date<input type="date" name="date" defaultValue={date ?? ""} /></label>
      </div>
      <p className="small muted" style={{ margin: 0 }}>Their first day working at Hermosa. Owners and the General Manager can change it any time; every change is logged.</p>
      <div><button type="submit" className="secondary" disabled={pending}>{pending ? "Saving…" : "Save start date"}</button>
        {state?.error && <span className="field-error"> {state.error}</span>}
        {state?.ok && <span className="small ok-text"> {state.ok}</span>}</div>
    </form>
  );
}
