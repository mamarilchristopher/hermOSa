"use client";
import { useActionState, useState } from "react";
import { tagIrregular, untagIrregular } from "@/app/time/actions";


/** Mark one person's day, or the whole day (no employee), as irregular: reason dropdown, typed reason for Other. */
export function IrregularTagForm({ date, employee, label }: { date: string; employee?: string; label: string }) {
  const [state, action, pending] = useActionState(tagIrregular, undefined);
  const [reason, setReason] = useState("");
  return (
    <details className="irregular-tag">
      <summary className="small">{label}</summary>
      <form action={action} className="irregular-form">
        <input type="hidden" name="date" value={date} />
        <input type="hidden" name="employee" value={employee ?? ""} />
        <select name="reason" required value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason">
          <option value="" disabled>Reason…</option>
          <option value="MAINTENANCE">Maintenance</option>
          <option value="EMERGENCY">Emergency</option>
          <option value="OTHER">Other (type it)</option>
        </select>
        {reason === "OTHER" && <input name="note" required minLength={3} maxLength={300} placeholder="Type the reason" aria-label="Other reason" />}
        <button type="submit" className="secondary small" disabled={pending || !reason}>{pending ? "Saving…" : "Mark irregular"}</button>
        {state?.error && <span className="field-error small">{state.error}</span>}
        {state?.ok && <span className="small ok-text">{state.ok}</span>}
      </form>
    </details>
  );
}

export function IrregularUndo({ id }: { id: string }) {
  const [state, action, pending] = useActionState(untagIrregular, undefined);
  return (
    <form action={action} style={{ display: "inline" }}>
      <input type="hidden" name="id" value={id} />
      <button type="submit" className="secondary small" disabled={pending}>{pending ? "Undoing…" : "Undo"}</button>
      {state?.error && <span className="field-error small"> {state.error}</span>}
    </form>
  );
}
