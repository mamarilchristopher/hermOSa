import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAccess, branchesFor, can } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { centsToPhp } from "@/lib/csv";
import { manilaToday } from "@/lib/dates";
import { monthStart } from "@/lib/insights";
import { EmployeeForm } from "./EmployeeForm";
import { PositionCell } from "./PositionCell";
import { byRankThenName, staffRank } from "@/lib/staffOrder";

export default async function People() {
  const { supabase, access, branches } = await requireAccess();
  const manage = branchesFor(access, branches, ["OWNER", "HR", "MANAGER"]);
  const viewAll = can(access, ["OWNER", "FINANCE", "HR", "AUDITOR"], null);
  if (manage.length === 0 && !viewAll) redirect("/");
  const isOwner = can(access, ["OWNER"], null);
  const from = monthStart(manilaToday());
  const [{ data: emps }, { data: lines }, { data: users }, { data: grants }] = await Promise.all([
    supabase.from("employees").select("id, full_name, branch_id, position, commission_eligible, active, app_user_id").order("full_name"),
    supabase.from("commission_lines").select("employee_id, amount_cents, service_logs!inner(service_date, state)").gte("service_logs.service_date", from).neq("service_logs.state", "REJECTED"),
    isOwner ? supabase.from("app_users").select("id, display_name").eq("active", true).order("display_name") : Promise.resolve({ data: null }),
    supabase.from("role_grants").select("user_id, role_code, branch_id").is("revoked_at", null),
  ]);
  type Emp = { full_name: string; position: string | null; app_user_id: string | null; active: boolean };
  const rank = (e: Emp) => staffRank((grants ?? []).filter((g) => g.user_id === e.app_user_id), e.position) + (e.active ? 0 : 10);
  const monthTotals = new Map<string, { approved: number; pending: number }>();
  for (const l of (lines ?? []) as unknown as { employee_id: string; amount_cents: number; service_logs: { state: string } }[]) {
    const t = monthTotals.get(l.employee_id) ?? { approved: 0, pending: 0 };
    if (l.service_logs.state === "APPROVED") t.approved += Number(l.amount_cents);
    else t.pending += Number(l.amount_cents);
    monthTotals.set(l.employee_id, t);
  }
  const byBranch = branches.filter((b) => b.kind === "CLINIC").map((b) => ({ b, list: byRankThenName((emps ?? []).filter((e) => e.branch_id === b.id), rank, (e) => e.full_name) })).filter((x) => x.list.length > 0);

  return (
    <>
      <TopBar access={access} />
      <main>
        <h1>Employees</h1>
        <p className="muted small">Staff records and this month&apos;s commission. Open someone to see every commission line.</p>
        {byBranch.length === 0 && <div className="notice info">No employees yet. Add the first one below.</div>}
        {byBranch.map(({ b, list }) => (
          <div key={b.id}>
            <h2>{b.name}</h2>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Name</th><th>Position</th><th>Commission</th><th className="num">This month (approved)</th><th className="num">Waiting sign-off</th></tr></thead>
                <tbody>
                  {list.map((e) => {
                    const t = monthTotals.get(e.id);
                    return (
                      <tr key={e.id} className={e.active ? undefined : "rejected"}>
                        <td><Link href={`/people/${e.id}`}><strong>{e.full_name}</strong></Link>{!e.active && <span className="pill REVERSED" style={{ marginLeft: 6 }}>Inactive</span>}</td>
                        <td>{manage.some((m) => m.id === e.branch_id) ? <PositionCell employeeId={e.id} position={e.position} /> : e.position ?? <span className="muted">–</span>}</td>
                        <td>{e.commission_eligible ? <span className="tag LEAD">Commission-based</span> : <span className="tag NONCOMMI">No commission</span>}</td>
                        <td className="num">{t ? centsToPhp(t.approved) : "–"}</td>
                        <td className="num muted">{t?.pending ? centsToPhp(t.pending) : "–"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ))}
        {manage.length > 0 && (
          <div className="card">
            <h2>Add an employee</h2>
            <EmployeeForm branches={manage.map((b) => ({ id: b.id, name: b.name }))} logins={users ? users.map((u) => ({ id: u.id, name: u.display_name })) : null} />
          </div>
        )}
      </main>
    </>
  );
}
