"use client";
import { useActionState, useState } from "react";
import { approveJoin, createInvite } from "./actions";

export const LEVEL_TEXT: Record<string, string> = {
  OWNER: "Owner (everything, needs 2-step sign-in)",
  GM: "General Manager (all branches, signs off commissions)",
  SENIOR_CMA: "Senior CMA (own branch, on commission)",
  CMA: "CMA (own branch, on commission)",
  TRAINEE: "Trainee (own branch, no commission by default)",
  CSR: "CSR (online bookings, all branches, WFH, basic pay only)",
  MANAGER: "Branch manager (one branch)",
  CASHIER: "Front desk / cashier (one branch)",
};

/** Levels a General Manager may approve: everything but Owner (update-0028; the database checks this too). */
export const GM_LEVELS = Object.keys(LEVEL_TEXT).filter((k) => k !== "OWNER");

export function ApproveForm({ user, branchId, branches, levels, asked }: { user: string; branchId: string | null; branches: { id: string; name: string }[]; levels?: string[]; asked?: string | null }) {
  const [state, action, pending] = useActionState(approveJoin, undefined);
  const v = state?.values ?? {};
  return (
    <form action={action} className="approve-form" key={state?.n ?? 0}>
      <input type="hidden" name="user" value={user} />
      <label>
        <span>Staff level</span>
        <select name="level" required defaultValue={v.level || (asked && asked in LEVEL_TEXT && (!levels || levels.includes(asked)) ? asked : "")}>
          <option value="" disabled>Choose a level…</option>
          {Object.entries(LEVEL_TEXT).filter(([k]) => !levels || levels.includes(k)).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </label>
      <label>
        <span>Home branch</span>
        <select name="branch" required defaultValue={v.branch || branchId || ""}>
          <option value="" disabled>Choose…</option>
          {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </label>
      <label><span>Position title (optional)</span><input name="position" maxLength={80} placeholder="Uses the level name" defaultValue={v.position ?? ""} /></label>
      <label>
        <span>Commission</span>
        <select name="commission" defaultValue={v.commission || "default"}>
          <option value="default">By level (CMAs yes, others no)</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      </label>
      <button type="submit" disabled={pending}>{pending ? "Approving…" : "Approve"}</button>
      {state?.error && <div className="notice error">{state.error}</div>}
      {state?.ok && <div className="notice ok">{state.ok}</div>}
    </form>
  );
}

export function CopyLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-link">
      <input readOnly value={url} aria-label="Invite link" onFocus={(e) => e.currentTarget.select()} />
      <button type="button" className="secondary" onClick={async () => {
        try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* select and copy by hand */ }
      }}>{copied ? "Copied" : "Copy"}</button>
    </div>
  );
}

export function NewInviteForm() {
  const [state, action, pending] = useActionState(createInvite, undefined);
  return (
    <form action={action} className="inline-form">
      <label><span>Link works for</span>
        <select name="days" defaultValue="14"><option value="3">3 days</option><option value="7">7 days</option><option value="14">14 days</option><option value="30">30 days</option></select>
      </label>
      <button type="submit" disabled={pending}>{pending ? "Making…" : "Make invite link"}</button>
      {state?.error && <div className="notice error">{state.error}</div>}
    </form>
  );
}
