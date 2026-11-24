"use client";
import { useActionState, useEffect, useState } from "react";
import { setPosition } from "./actions";

const SUGGESTED = ["Owner", "General Manager", "Senior CMA", "CMA"];

/** Inline position editor: the Confirm button only appears once the text changes. */
export function PositionCell({ employeeId, position }: { employeeId: string; position: string | null }) {
  const [state, action, pending] = useActionState(setPosition, undefined);
  const [value, setValue] = useState(position ?? "");
  const [saved, setSaved] = useState(position ?? "");
  useEffect(() => { if (state?.ok) setSaved(value.trim()); }, [state]); // eslint-disable-line react-hooks/exhaustive-deps
  const changed = value.trim() !== saved;
  return (
    <form action={action} className="position-cell">
      <input type="hidden" name="id" value={employeeId} />
      <input name="position" list={`pos-${employeeId}`} value={value} maxLength={80} placeholder="Set position"
        aria-label="Position" onChange={(e) => setValue(e.target.value)} />
      <datalist id={`pos-${employeeId}`}>{SUGGESTED.map((s) => <option key={s} value={s} />)}</datalist>
      {changed && (
        <>
          <button type="submit" className="small" disabled={pending}>{pending ? "Saving…" : "Confirm"}</button>
          <button type="button" className="secondary small" onClick={() => setValue(saved)} disabled={pending}>Cancel</button>
        </>
      )}
      {!changed && state?.ok && <span className="small saved-tick">✓ Saved</span>}
      {state?.error && <span className="field-error">{state.error}</span>}
    </form>
  );
}
