import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAccess, branchesFor, can } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { centsToPhp } from "@/lib/csv";
import { isIsoDate, manilaToday } from "@/lib/dates";
import { addDays, WEEKDAYS, weekday } from "@/lib/insights";
import { ROLE_TEXT, TYPE_TEXT } from "@/lib/commission";
import { DecideButtons, EntryForm } from "./Forms";

type Log = {
  id: string; service_date: string; amount_paid_cents: number; commission_type: string; performer_id: string; assistant_id: string | null;
  receipt_no: string | null; note: string | null; state: string; visit_kind?: string; created_by: string; created_at: string; decision_note: string | null;
  services: { name: string } | null;
};
const VISIT_TEXT: Record<string, string> = { BACKJOB: "Backjob (unpaid)", CHECKUP: "Check-up (unpaid)", NO_CHARGE: "No charge" };
type Line = { service_log_id: string; employee_id: string; role: string; amount_cents: number };

export default async function ServiceLog({ searchParams }: { searchParams: Promise<{ date?: string; branch?: string }> }) {
  const { supabase, access, branches } = await requireAccess();
  const sp = await searchParams;
  const viewable = branchesFor(access, branches, ["OWNER", "FINANCE", "MANAGER", "CASHIER", "CLINICIAN", "HR", "AUDITOR"]);
  if (viewable.length === 0) redirect("/");
  const branch = viewable.find((b) => b.code === sp.branch) ?? viewable[0];
  const today = manilaToday();
  const date = isIsoDate(sp.date) && sp.date <= today ? sp.date : today;
  const canLog = can(access, ["OWNER", "FINANCE", "MANAGER", "CASHIER", "CLINICIAN"], branch.id);
  const approver = can(access, ["OWNER", "MANAGER"], branch.id);
  const isManager = can(access, ["OWNER", "MANAGER"], null) || branchesFor(access, branches, ["MANAGER"]).length > 0;

  const [{ data: services }, { data: emps }, { data: logs }] = await Promise.all([
    supabase.from("services").select("id, name, price_cents, commission_cents").eq("active", true).order("name"),
    supabase.from("employees").select("id, full_name, branch_id, commission_eligible, app_user_id").eq("active", true).order("full_name"),
    supabase.from("service_logs").select("*, services(name)")
      .eq("branch_id", branch.id).eq("service_date", date).order("created_at"),
  ]);
  const list = (logs ?? []) as unknown as Log[];
  const { data: lineRows } = list.length
    ? await supabase.from("commission_lines").select("service_log_id, employee_id, role, amount_cents").in("service_log_id", list.map((l) => l.id))
    : { data: [] as Line[] };
  const lines = (lineRows ?? []) as Line[];
  const name = Object.fromEntries((emps ?? []).map((e) => [e.id, e.full_name]));
  const mine = new Set((emps ?? []).filter((e) => e.app_user_id === access.user_id).map((e) => e.id));
  const employees = (emps ?? []).map((e) => ({ id: e.id, name: e.full_name, eligible: e.commission_eligible, here: e.branch_id === branch.id }));
  // Staff who aren't on commission never see commission choices (management still does, to log for others).
  const myEmp = (emps ?? []).find((e) => e.app_user_id === access.user_id);
  const noCommission = !!myEmp && !myEmp.commission_eligible && !access.grants.some((g) => ["OWNER", "FINANCE", "MANAGER", "AUDITOR"].includes(g.role));

  const paid = list.filter((l) => l.state !== "REJECTED").reduce((s, l) => s + Number(l.amount_paid_cents), 0);
  const commission = lines.filter((x) => list.find((l) => l.id === x.service_log_id)?.state !== "REJECTED").reduce((s, x) => s + Number(x.amount_cents), 0);
  const pendingCount = list.filter((l) => l.state === "PENDING").length;
  const link = (d: string, b = branch.code) => `/services?date=${d}&branch=${b}`;
  const dayLabel = `${WEEKDAYS[weekday(date)]}, ${new Date(`${date}T00:00:00Z`).toLocaleDateString("en-PH", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })}`;

  return (
    <>
      <TopBar access={access} />
      <main>
        <h1>Service Log</h1>
        <p className="muted small">Every service done today, who did it and the commission. A manager signs off each entry.</p>

        <div className="periods card">
          <div className="segmented" aria-label="Branch">
            {viewable.map((b) => <Link key={b.id} href={link(date, b.code)} className={b.id === branch.id ? "on" : ""}>{b.name}</Link>)}
          </div>
          <form className="day-nav">
            <input type="hidden" name="branch" value={branch.code} />
            <Link className="button secondary small" href={link(addDays(date, -1))} aria-label="Previous day">←</Link>
            <input type="date" name="date" defaultValue={date} max={today} aria-label="Date" />
            <button type="submit" className="secondary small">Go</button>
            {date < today && <Link className="button secondary small" href={link(addDays(date, 1))} aria-label="Next day">→</Link>}
            {date !== today && <Link className="button secondary small" href={link(today)}>Today</Link>}
          </form>
        </div>

        <div className="grid">
          <div className="card stat hero"><div className="label">{branch.name} · {dayLabel}</div><div className="value">{centsToPhp(paid)}</div><div className="note">{(() => { const ok = list.filter((l) => l.state !== "REJECTED"); const unpaid = ok.filter((l) => l.visit_kind && l.visit_kind !== "PAID").length; return `${ok.length - unpaid} paid services${unpaid ? `, ${unpaid} unpaid visit${unpaid === 1 ? "" : "s"}` : ""}`; })()}</div></div>
          {approver && <div className="card stat"><div className="label">Commission</div><div className="value">{centsToPhp(commission)}</div><div className="note">5% of amount paid, lead 60 / assist 40</div></div>}
          <div className="card stat"><div className="label">Sign-off</div><div className="value">{pendingCount === 0 ? (list.length ? "All signed" : "–") : `${pendingCount} waiting`}</div><div className="note">{approver ? "Approve each entry below" : "Your manager signs these off"}</div></div>
        </div>

        {canLog && (
          <div className="card">
            <h2>Add a service</h2>
            {(services ?? []).length === 0 || employees.length === 0 ? (
              <div className="notice info">
                {employees.length === 0 ? <>Add the branch&apos;s staff first on <Link href="/people">Employees</Link>. </> : null}
                {(services ?? []).length === 0 ? "Add your services below first." : null}
              </div>
            ) : (
              <EntryForm branch={branch.id} date={date} services={(services ?? []).map((s) => ({ id: s.id, name: s.name, price: s.price_cents ?? null, commission: s.commission_cents ?? null }))} employees={employees} noCommission={noCommission} />
            )}
            {isManager && <p className="small" style={{ marginTop: 12 }}><Link href="/services/prices">Price list and commissions</Link> (add a service, set its price and commission)</p>}
          </div>
        )}

        <h2>Entries</h2>
        <div className="table-wrap">
          <table className="log-table">
            <thead>
              <tr><th>Service</th><th className="num">Paid</th><th>Type</th><th>Staff and commission</th><th>Status</th></tr>
            </thead>
            <tbody>
              {list.map((l) => {
                const ls = lines.filter((x) => x.service_log_id === l.id);
                const staff = [l.performer_id, l.assistant_id].filter(Boolean) as string[];
                return (
                  <tr key={l.id} className={l.state === "REJECTED" ? "rejected" : undefined}>
                    <td><strong>{l.services?.name}</strong>{l.receipt_no && <div className="small muted">Waiver / OR {l.receipt_no}</div>}{l.note && <div className="small muted">{l.note}</div>}</td>
                    <td className="num">{centsToPhp(l.amount_paid_cents)}</td>
                    <td>{l.visit_kind && l.visit_kind !== "PAID"
                      ? <span className="tag">{VISIT_TEXT[l.visit_kind] ?? l.visit_kind}</span>
                      : <span className={`tag ${l.commission_type}`}>{TYPE_TEXT[l.commission_type]}</span>}</td>
                    <td>
                      {staff.map((id, i) => {
                        const line = ls.find((x) => x.employee_id === id);
                        const role = l.commission_type === "LEAD" ? (i === 0 ? "lead" : "assist") : l.commission_type === "SOLO" ? "solo" : "";
                        return (
                          <div key={id} className="staff-line">
                            <span>{name[id] ?? "Former staff"}{mine.has(id) && <span className="muted"> (you)</span>}</span>
                            <span className="muted small">
                              {line ? `${centsToPhp(line.amount_cents)} ${ROLE_TEXT[line.role]}` : l.commission_type === "NONCOMMI" ? "" : approver || mine.has(id) ? `no commission · ${role}` : role}
                            </span>
                          </div>
                        );
                      })}
                    </td>
                    <td>
                      {l.state === "PENDING" && approver ? <DecideButtons id={l.id} /> : (
                        <span className={`pill ${l.state === "APPROVED" ? "PUBLISHED" : l.state === "REJECTED" ? "REVERSED" : "STAGED"}`}>
                          {l.state === "APPROVED" ? "Approved" : l.state === "REJECTED" ? "Rejected" : "Waiting"}
                        </span>
                      )}
                      {l.state === "REJECTED" && l.decision_note && <div className="small muted">{l.decision_note}</div>}
                    </td>
                  </tr>
                );
              })}
              {list.length === 0 && <tr><td colSpan={5} className="muted">Nothing logged for this day yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </main>
    </>
  );
}
