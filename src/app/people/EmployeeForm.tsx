"use client";
import { useActionState } from "react";
import { saveEmployee } from "./actions";

type E = { id: string; full_name: string; branch_id: string; position: string | null; commission_eligible: boolean; app_user_id: string | null; active: boolean };

export function EmployeeForm({ branches, logins, employee }: { branches: { id: string; name: string }[]; logins: { id: string; name: string }[] | null; employee?: E }) {
  const [state, action, pending] = useActionState(saveEmployee, undefined);
  return (
    <form action={action} className="stack wide">
      {state?.error && <div className="notice error">{state.error}</div>}
      {state?.ok && <div className="notice ok">{state.ok}</div>}
      <input type="hidden" name="id" value={employee?.id ?? ""} />
      <div className="entry-grid">
        <label>Full name<input name="name" required minLength={2} maxLength={120} defaultValue={employee?.full_name} /></label>
        <label>Position<input name="position" maxLength={80} placeholder="e.g. Therapist" defaultValue={employee?.position ?? ""} /></label>
        <label>Home branch
          <select name="branch" required defaultValue={employee?.branch_id ?? branches[0]?.id}>
            {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </label>
        <label>Commission-based?
          <select name="commission" defaultValue={employee ? (employee.commission_eligible ? "yes" : "no") : "yes"}>
            <option value="yes">Yes, earns commission</option>
            <option value="no">No commission</option>
          </select>
        </label>
        {logins && (
          <label><span>App login <span className="muted">(lets them see their own commission)</span></span>
            <select name="login" defaultValue={employee?.app_user_id ?? ""}>
              <option value="">Not linked</option>
              {logins.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </label>
        )}
        {employee && (
          <label>Status
            <select name="active" defaultValue={employee.active ? "yes" : "no"}>
              <option value="yes">Active</option>
              <option value="no">No longer working here</option>
            </select>
          </label>
        )}
      </div>
      <div><button type="submit" disabled={pending}>{pending ? "Saving…" : employee ? "Save changes" : "Add employee"}</button></div>
    </form>
  );
}
