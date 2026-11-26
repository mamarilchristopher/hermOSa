"use client";
import { useActionState, useState } from "react";
import { BACKJOB_REASONS } from "@/lib/backjobs";
import { retagBackjob } from "./actions";

/** Change who did the first treatment and what needed fixing, right on the backjob's row. */
export function Retag({ log, staff, reason, people }: { log: string; staff: string | null; reason: string | null; people: { id: string; name: string }[] }) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(retagBackjob, undefined);
  if (!open) return <button type="button" className="link-button small" onClick={() => setOpen(true)}>Change</button>;
  return (
    <form action={action} className="bj-retag">
      <input type="hidden" name="log" value={log} />
      <select name="staff" defaultValue={staff ?? ""} aria-label="First treatment done by">
        <option value="">Find it automatically</option>
        {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <select name="reason" defaultValue={reason ?? ""} aria-label="What needed fixing">
        <option value="">Reason not given</option>
        {BACKJOB_REASONS.map((r) => <option key={r.v} value={r.v}>{r.label}</option>)}
      </select>
      <button type="submit" className="small" disabled={pending}>{pending ? "Saving…" : "Save"}</button>
      <button type="button" className="secondary small" onClick={() => setOpen(false)}>Cancel</button>
      {state?.error && <span className="small" style={{ color: "var(--bad)" }}>{state.error}</span>}
      {state?.ok && <span className="small">{state.ok}</span>}
    </form>
  );
}
