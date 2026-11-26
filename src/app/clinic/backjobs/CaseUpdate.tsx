"use client";
import { useActionState, useEffect, useState } from "react";
import { CASE_STATUSES, isClosed } from "@/lib/backjobs";
import { updateCase } from "./actions";

/** Update a backjob case: status, what was done, and the refund amount when refunded. */
export function CaseUpdate({ id, status, resolution, refund }: { id: string; status: string; resolution: string | null; refund: number | null }) {
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState(status);
  const [state, action, pending] = useActionState(updateCase, undefined);
  const closed = isClosed(status);
  useEffect(() => { if (state?.ok) setOpen(false); }, [state]);
  if (!open) {
    return (
      <div className="bj-case-actions">
        <button type="button" className="secondary small" onClick={() => { setPick(status); setOpen(true); }}>{closed ? "Reopen or edit" : "Update or close"}</button>
        {state?.ok && <span className="small">{state.ok}</span>}
      </div>
    );
  }
  const closing = isClosed(pick);
  return (
    <form action={action} className="bj-case-form" key={state?.n ?? 0}>
      <input type="hidden" name="id" value={id} />
      <label>
        <span>Status</span>
        <select name="status" value={pick} onChange={(e) => setPick(e.target.value)}>
          {CASE_STATUSES.map((s) => <option key={s.v} value={s.v}>{s.closed ? `Close: ${s.label}` : s.label}</option>)}
        </select>
      </label>
      {pick === "REFUNDED" && (
        <label>
          <span>Refund amount (₱)</span>
          <input name="refund" inputMode="decimal" required defaultValue={refund ? String(refund / 100) : ""} placeholder="e.g. 2,500" />
        </label>
      )}
      <label className="wide">
        <span>{closing ? "What was done (needed to close)" : "Note (optional)"}</span>
        <textarea name="resolution" rows={2} maxLength={500} required={closing} defaultValue={resolution ?? ""}
          placeholder={pick === "QUITCLAIM" ? "e.g. Client signed the quitclaim after a free touch-up, Nov 27" : pick === "REFUNDED" ? "e.g. Refunded half by GCash, client agreed" : "e.g. Touch-up done, client happy with the result"} />
      </label>
      <div className="bj-case-buttons">
        <button type="submit" className="small" disabled={pending}>{pending ? "Saving…" : closing ? "Close case" : "Save"}</button>
        <button type="button" className="secondary small" onClick={() => setOpen(false)}>Cancel</button>
      </div>
      {state?.error && <div className="notice error small">{state.error}</div>}
    </form>
  );
}
