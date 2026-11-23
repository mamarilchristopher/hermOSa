"use client";
import { useActionState } from "react";
import { fillDay } from "./actions";

export function FillForm({ branch, date }: { branch: string; date: string }) {
  const [state, action, pending] = useActionState(fillDay, undefined);
  if (state?.ok) return <span className="small" style={{ color: "var(--good)", fontWeight: 600 }}>✓ {state.ok}</span>;
  return (
    <form action={action} className="fill-row">
      <input type="hidden" name="branch" value={branch} />
      <input type="hidden" name="date" value={date} />
      <input name="amount" inputMode="decimal" placeholder="Sales ₱" aria-label={`Sales on ${date}`} />
      <button type="submit" name="mode" value="amount" disabled={pending}>Save</button>
      <button type="submit" name="mode" value="closed" className="secondary" disabled={pending} formNoValidate>Closed</button>
      {state?.error && <span className="small" style={{ color: "var(--bad)" }}>{state.error}</span>}
    </form>
  );
}
