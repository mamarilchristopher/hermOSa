import Link from "next/link";
import { requireAccess } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { Reveal } from "@/components/Reveal";
import { centsToPhp } from "@/lib/csv";
import { manilaToday } from "@/lib/dates";
import { monthEnd, monthLabel, monthStart } from "@/lib/insights";
import { ROLE_TEXT } from "@/lib/commission";

const ROLE_LABEL: Record<string, string> = {
  OWNER: "Owner", FINANCE: "Finance", MANAGER: "Manager", CASHIER: "Front desk", HR: "HR",
  MARKETING: "Marketing", CLINICIAN: "Clinician", INVENTORY: "Inventory", AUDITOR: "Auditor",
};

type Line = { role: string; amount_cents: number; service_logs: { service_date: string; state: string; services: { name: string } | null } };

/** Staff Home: your own details and, for commission staff, this month's running commission (covered until tapped). */
export default async function Me() {
  const { supabase, access, branches } = await requireAccess();
  const today = manilaToday();
  const start = monthStart(today), ym = today.slice(0, 7);
  const [{ data: emp }, { data: user }] = await Promise.all([
    supabase.from("employees").select("id, full_name, branch_id, position, commission_eligible, active").eq("app_user_id", access.user_id).maybeSingle(),
    supabase.from("app_users").select("email, joined_at").eq("id", access.user_id).maybeSingle(),
  ]);
  const { data } = emp?.commission_eligible
    ? await supabase.from("commission_lines").select("role, amount_cents, service_logs!inner(service_date, state, services(name))")
        .eq("employee_id", emp.id).gte("service_logs.service_date", start).lte("service_logs.service_date", monthEnd(start))
    : { data: [] };
  const lines = (data ?? []) as unknown as Line[];
  const sum = (state: string) => lines.filter((l) => l.service_logs.state === state).reduce((s, l) => s + Number(l.amount_cents), 0);
  const approved = sum("APPROVED"), waiting = sum("PENDING");
  const recent = lines.filter((l) => l.service_logs.state !== "REJECTED")
    .sort((a, b) => b.service_logs.service_date.localeCompare(a.service_logs.service_date)).slice(0, 5);
  const branchName = Object.fromEntries(branches.map((b) => [b.id, b.name]));
  const scope = access.grants.map((g) => `${ROLE_LABEL[g.role] ?? g.role}, ${g.branch_id ? branchName[g.branch_id] ?? "branch" : "all branches"}`);
  const first = access.display_name.split(/\s+/)[0];
  const logger = access.grants.some((g) => ["OWNER", "FINANCE", "MANAGER", "CASHIER", "CLINICIAN", "HR", "AUDITOR"].includes(g.role));

  return (
    <>
      <TopBar access={access} />
      <main>
        <h1>Hi, {first}</h1>
        <p className="muted small">{emp?.position ?? "Staff"}{emp && ` · ${branchName[emp.branch_id]}`}</p>

        {emp?.commission_eligible && (
          <>
            <div className="grid">
              <div className="card stat hero">
                <Reveal label={`Approved commission, ${monthLabel(ym)}`} note="Signed off by your manager. This is what goes to payroll.">{centsToPhp(approved)}</Reveal>
              </div>
              <div className="card stat">
                <Reveal label="Waiting sign-off" note="Counts once your manager approves it.">{centsToPhp(waiting)}</Reveal>
              </div>
            </div>
            <p className="small muted">Only you and management can see your commission. Figures stay covered until you tap them.</p>
            {recent.length > 0 && (
              <div className="card">
                <h2>Latest this month</h2>
                <ul className="plain-list">
                  {recent.map((l, i) => (
                    <li key={i}>
                      <span>{l.service_logs.service_date.slice(5).replace("-", "/")} · {l.service_logs.services?.name}</span>
                      <span className={`tag ${l.role}`}>{ROLE_TEXT[l.role]}</span>
                      {l.service_logs.state === "PENDING" && <span className="pill STAGED">Waiting</span>}
                    </li>
                  ))}
                </ul>
                <Link href={`/people/${emp.id}`}>See every line and past months →</Link>
              </div>
            )}
          </>
        )}

        <div className="card">
          <h2>My details</h2>
          <dl className="kv" style={{ borderTop: 0, paddingTop: 0 }}>
            <dt>Name</dt><dd>{emp?.full_name ?? access.display_name}</dd>
            <dt>Position</dt><dd>{emp?.position ?? "Not set yet"}</dd>
            <dt>Home branch</dt><dd>{emp ? branchName[emp.branch_id] : "Not set yet"}</dd>
            <dt>Commission</dt><dd>{emp ? (emp.commission_eligible ? "Yes, 5% of amount paid" : "No") : "Not set yet"}</dd>
            <dt>App access</dt><dd>{scope.join("; ") || "None yet"}</dd>
            <dt>Login email</dt><dd>{user?.email ?? ""}</dd>
            {user?.joined_at && <><dt>Joined the app</dt><dd>{user.joined_at.slice(0, 10)}</dd></>}
          </dl>
          <p className="small muted" style={{ marginBottom: 0 }}>Something wrong here? Tell your manager or the owner. Payroll details come later.</p>
        </div>

        {logger && (
          <div className="card">
            <h2>Quick links</h2>
            <Link className="button" href="/services">Open the service log</Link>
          </div>
        )}
      </main>
    </>
  );
}
