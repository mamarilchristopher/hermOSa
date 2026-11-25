"use client";
import { pick } from "@/lib/decision";
import { useActionState } from "react";
import { decideDay, fillDay } from "./actions";

export function FillForm({ branch, date }: { branch: string; date: string }) {
  const [state, action, pending] = useActionState(fillDay, undefined);
  if (state?.ok) return <span className="small" style={{ color: "var(--good)", fontWeight: 600 }}>✓ {state.ok}</span>;
  return (
    <form action={action} className="fill-row">
      <input type="hidden" name="branch" value={branch} />
      <input type="hidden" name="date" value={date} />
      <input name="amount" inputMode="decimal" placeholder="Sales ₱" aria-label={`Sales on ${date}`} />
      <button type="submit" name="mode" value="amount" disabled={pending}>Save</button>
      <button type="submit" name="mode" value="CLOSED" className="secondary" disabled={pending} formNoValidate>Closed</button>
      <button type="submit" name="mode" value="NO_SALES" className="secondary" disabled={pending} formNoValidate>Zero sales</button>
      {state?.error && <span className="small" style={{ color: "var(--bad)" }}>{state.error}</span>}
    </form>
  );
}

export function DecideForm({ mark, label, by, canDecide }: { mark: string; label: string; by: string; canDecide: boolean }) {
  const [state, action, pending] = useActionState(decideDay, undefined);
  if (state?.ok) return <span className="small" style={{ color: "var(--good)", fontWeight: 600 }}>✓ {state.ok}</span>;
  return (
    <form action={action} className="fill-row">
      <input type="hidden" name="mark" value={mark} />
      <span className="small"><strong>{label}</strong> · marked by {by} · needs a second person</span>
      {canDecide && (
        <>
          <button type="submit" onClick={pick("confirm")} disabled={pending}>Confirm</button>
          <button type="submit" onClick={pick("reject")} className="secondary" disabled={pending}>Reject</button>
        </>
      )}
      {state?.error && <span className="small" style={{ color: "var(--bad)" }}>{state.error}</span>}
    </form>
  );
}
