"use client";
import { useActionState } from "react";
import { deleteClientVisit } from "./actions";

/** Owners and the GM: delete a client folder (the visit, its commission and its photos). Asks first. */
export function DeleteFolder({ id, client }: { id: string; client: string }) {
  const [state, action, pending] = useActionState(deleteClientVisit, undefined);
  if (state?.done) return <span className="small muted">Deleted.</span>;
  return (
    <form action={action} className="fill-row"
      onSubmit={(e) => { if (!confirm(`Delete ${client}'s folder? This removes the service log entry, its commission and all its photos for good.`)) e.preventDefault(); }}>
      <input type="hidden" name="log" value={id} />
      <button type="submit" className="danger small" disabled={pending}>{pending ? "Deleting…" : "Delete"}</button>
      {state?.error && <span className="small" style={{ color: "var(--bad)" }}>{state.error}</span>}
    </form>
  );
}
