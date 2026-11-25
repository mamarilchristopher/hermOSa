"use client";
import { useActionState } from "react";
import { grantRole } from "./actions";

const ROLE_LABELS: Record<string, string> = {
  OWNER: "Owner / System admin", FINANCE: "Finance", MANAGER: "Branch manager", CASHIER: "Cashier / front desk",
  HR: "HR / Payroll", MARKETING: "Marketing", CLINICIAN: "Clinician / therapist", INVENTORY: "Inventory / purchasing", AUDITOR: "Auditor (read-only)", CSR: "CSR (online bookings)",
};

export function GrantForm({ users, branches }: { users: { id: string; display_name: string }[]; branches: { id: string; name: string }[] }) {
  const [state, action, pending] = useActionState(grantRole, undefined);
  return (
    <form action={action} className="stack">
      {state?.error && <div className="notice error">{state.error}</div>}
      {state?.ok && <div className="notice ok">{state.ok}</div>}
      <label>Person<select name="user" required>{users.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}</select></label>
      <label>Role<select name="role" required>{Object.entries(ROLE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <label>
        Branch
        <select name="branch" required>
          <option value="ALL">All branches</option>
          {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </label>
      <button type="submit" disabled={pending}>{pending ? "Saving…" : "Add role"}</button>
    </form>
  );
}
