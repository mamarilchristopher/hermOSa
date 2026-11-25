import Link from "next/link";
import { redirect } from "next/navigation";
import { can, requireAccess } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { Uid } from "@/components/Uid";
import { openPayroll, deleteHoliday, addThirteenth, decideCola, openPayslip } from "./actions";
import { ColaForm, FinalizeForm, HolidayForm, PayRateForm, RulesForm, type PaySetting } from "./Forms";
import { peso, periodLabel, manilaToday, shortDate, ROLE_TEXT, type CommissionItem } from "@/lib/payroll";

type Run = { id: string; period_start: string; period_end: string; state: "DRAFT" | "FINAL"; computed_at: string | null; finalized_at: string | null };
type Slip = { id: string; employee_id: string; slip_no: string; gross_cents: number; deductions_cents: number; net_cents: number;
  earnings: { label: string; amount: number }[]; commissions: CommissionItem[] | null; employees: { full_name: string; uid: string | null } | null };
type Emp = { id: string; uid: string | null; full_name: string; position: string | null };

/** Payroll per cutoff (update-0046). Owners and the GM. */
export default async function PayrollPage({ searchParams }: { searchParams: Promise<{ run?: string; find?: string }> }) {
  const { supabase, access } = await requireAccess();
  if (!can(access, ["OWNER"], null) && !can(access, ["MANAGER"], null)) redirect("/payslips");
  const owner = can(access, ["OWNER"], null);
  const { run: runParam, find } = await searchParams;
  const today = manilaToday();

  const cutoffs: string[] = [];
  {
    let y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7)), first = Number(today.slice(8, 10)) <= 15;
    for (let i = 0; i < 36; i++) {
      cutoffs.push(`${y}-${String(m).padStart(2, "0")}-${first ? "01" : "16"}`);
      if (first) { m -= 1; if (m === 0) { m = 12; y -= 1; } }
      first = !first;
    }
  }
  const [{ data: runsData, error: runsErr }, { data: emps }, { data: settings }, { data: hols }, { data: org }] = await Promise.all([
    supabase.from("payroll_runs").select("id, period_start, period_end, state, computed_at, finalized_at").order("period_start", { ascending: false }).limit(24),
    supabase.from("employees").select("id, uid, full_name, position").eq("active", true).order("full_name"),
    supabase.from("pay_settings").select("employee_id, basis, rate_cents, allowance_cents, statutory, tax, deduct_lates, declared_cents, cola_cents"),
    supabase.from("holidays").select("holiday_date, name, kind").gte("holiday_date", `${Number(today.slice(0, 4)) - 1}-12-01`).order("holiday_date"),
    supabase.from("organizations").select("payroll_rules").maybeSingle(),
  ]);
  type ColaReq = { id: string; employee_id: string; old_cents: number; new_cents: number; created_at: string; employees: { full_name: string; uid: string | null } | null; app_users: { display_name: string | null } | null };
  const { data: colaData } = await supabase.from("cola_requests")
    .select("id, employee_id, old_cents, new_cents, created_at, employees(full_name, uid), app_users!cola_requests_requested_by_fkey(display_name)")
    .eq("state", "PENDING").order("created_at");
  const colaWaiting = (colaData ?? []) as unknown as ColaReq[];
  const waitingFor = new Map(colaWaiting.map((c) => [c.employee_id, Number(c.new_cents)]));
  const rules = ((org as { payroll_rules?: { statutory_cutoff?: string; special_worked_premium?: boolean } } | null)?.payroll_rules) ?? {};
  const runs = (runsData ?? []) as Run[];
  const runState = new Map(runs.map((r) => [r.period_start, r.state === "FINAL" ? "Final" : "Draft"]));
  const when = (t: string) => new Date(t).toLocaleString("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const run = runs.find((r) => r.id === runParam) ?? runs[0] ?? null;
  const { data: slipsData } = run
    ? await supabase.from("payslips").select("id, employee_id, slip_no, gross_cents, deductions_cents, net_cents, earnings, commissions, employees(full_name, uid)").eq("run_id", run.id)
    : { data: [] };
  const year = Number((run?.period_start ?? today).slice(0, 4));
  const { data: thirteenthData } = await supabase.rpc("thirteenth_month", { p_year: year });
  type T13 = { employee_id: string; name: string; uid: string | null; hire_date: string | null; monthly: number; months: number; prorated: boolean; absences: number; amount: number };
  const thirteenth = (Array.isArray(thirteenthData) ? thirteenthData : []) as T13[];
  const slips = ((slipsData ?? []) as unknown as Slip[]).sort((a, b) => (a.employees?.full_name ?? "").localeCompare(b.employees?.full_name ?? ""));
  const setting = new Map(((settings ?? []) as (PaySetting & { employee_id: string })[]).map((s) => [s.employee_id, s]));
  const staff = (emps ?? []) as Emp[];
  const noRate = staff.filter((e) => !setting.has(e.id));
  const sum = (k: "gross_cents" | "deductions_cents" | "net_cents") => slips.reduce((t, s) => t + Number(s[k]), 0);
  const comm = (s: Slip) => s.earnings.filter((l) => l.label.startsWith("Commission")).reduce((t, l) => t + l.amount, 0);

  return (
    <>
      <TopBar access={access} />
      <main>
        <h1>Payroll</h1>
        <p className="muted small">
          Twice a month: the 1st to the 15th, and the 16th to the month&apos;s end. Pay is worked out from the schedule, time clock, leave,
          irregular days and signed-off commissions. Check each payslip, add overtime, cash advances or loans, then finalize to send payslips to staff.
          Have your accountant check the first one.
        </p>
        {runsErr && <div className="notice info">{runsErr.code === "42P01" ? "The owner needs to run update-0046 in Supabase first." : "Could not load. Try again."}</div>}

        <div className="card pay-tools">
          <form action={openPayroll} className="pay-tool">
            <span className="pay-tool-title">Cutoff</span>
            <div className="pay-tool-row">
              <select name="date" defaultValue={run?.period_start ?? cutoffs[0]} aria-label="Cutoff">
                {cutoffs.map((d) => <option key={d} value={d}>{periodLabel(d)}{runState.get(d) ? ` · ${runState.get(d)}` : d === cutoffs[0] ? " · current" : ""}</option>)}
              </select>
              <button>Open</button>
            </div>
          </form>
          <form action={openPayslip} className="pay-tool">
            <span className="pay-tool-title">One person&apos;s payslip</span>
            <div className="pay-tool-row">
              <select name="employee" required defaultValue="" aria-label="Employee">
                <option value="" disabled>Employee…</option>
                {staff.map((e) => <option key={e.id} value={e.id}>{e.full_name}{e.uid ? ` (${e.uid})` : ""}</option>)}
              </select>
              <select name="date" defaultValue={run?.period_start ?? cutoffs[0]} aria-label="Cutoff">
                {cutoffs.map((d) => <option key={d} value={d}>{periodLabel(d)}</option>)}
              </select>
              <button className="secondary">View</button>
            </div>
          </form>
          {find === "none" && <p className="small" style={{ color: "var(--bad)", margin: 0 }}>No payslip for that person on that cutoff. Check that they have a pay rate.</p>}
          {find === "error" && <p className="small" style={{ color: "var(--bad)", margin: 0 }}>Could not open that cutoff. Try again.</p>}
        </div>

        {run && (
          <div className="card">
            <div className="run-head">
              <h2>{periodLabel(run.period_start)} <span className={`pill ${run.state === "FINAL" ? "PUBLISHED" : "STAGED"}`}>{run.state === "FINAL" ? "Final" : "Draft"}</span></h2>
              {run.state === "DRAFT" ? (
                <form action={openPayroll} className="run-head-meta">
                  <input type="hidden" name="date" value={run.period_start} />
                  <span>Worked out {run.computed_at ? when(run.computed_at) : "not yet"}</span>
                  <button className="secondary small">Recompute</button>
                </form>
              ) : (
                <span className="run-head-meta">Finalized {run.finalized_at ? when(run.finalized_at) : ""}</span>
              )}
            </div>
            {slips.length === 0 && <p className="muted small">No payslips. Set pay rates below first.</p>}
            {slips.length > 0 && (
              <>
                <div className="run-totals">
                  <div><span>People</span><strong>{slips.length}</strong></div>
                  <div><span>Gross</span><strong>{peso(sum("gross_cents"))}</strong></div>
                  <div><span>Deductions</span><strong>{peso(sum("deductions_cents"))}</strong></div>
                  <div className="net"><span>Net pay</span><strong>{peso(sum("net_cents"))}</strong></div>
                </div>
                <div className="slip-list">
                  <div className="slip-head" aria-hidden="true">
                    <span>Name</span><span>Commission</span><span>Gross</span><span>Deductions</span><span>Net pay</span><span />
                  </div>
                  {slips.map((s) => (
                    <Link key={s.id} href={`/payslips/${s.id}`} className="slip-row" title={run.state === "DRAFT" ? "Check or add lines" : "Open payslip"}>
                      <span className="slip-name">{s.employees?.full_name}<Uid v={s.employees?.uid ?? null} /></span>
                      <span className="slip-fig"><small>Commission</small>{comm(s) ? peso(comm(s)) : "–"}</span>
                      <span className="slip-fig"><small>Gross</small>{peso(s.gross_cents)}</span>
                      <span className="slip-fig"><small>Deductions</small>{Number(s.deductions_cents) ? peso(s.deductions_cents) : "–"}</span>
                      <span className="slip-net"><small>Net pay</small>{peso(s.net_cents)}</span>
                      <span className="slip-go" aria-hidden="true">›</span>
                      <span className="slip-sub">Gross {peso(s.gross_cents)} · Deductions {peso(s.deductions_cents)}{comm(s) ? ` · Commission ${peso(comm(s))}` : ""}</span>
                    </Link>
                  ))}
                </div>
              </>
            )}
            {slips.some((s) => (s.commissions ?? []).length > 0) && (
              <div className="comm-drill">
                <h3>Commission details</h3>
                <p className="muted small">Signed-off services up to the end of this cutoff that weren&apos;t paid before. Tap a name to see each one.</p>
                {slips.filter((s) => (s.commissions ?? []).length > 0).map((s) => {
                  const list = s.commissions ?? [];
                  return (
                    <details key={s.id} className="comm-person">
                      <summary>
                        <span className="slip-name">{s.employees?.full_name}<Uid v={s.employees?.uid ?? null} /></span>
                        <span className="small muted">{list.length} service{list.length === 1 ? "" : "s"}</span>
                        <strong>{peso(comm(s))}</strong>
                      </summary>
                      <div className="comm-lines">
                        <div className="comm-line comm-line-head" aria-hidden="true"><span>Date</span><span>Service</span><span>Role</span><span>Paid</span><span>Commission</span></div>
                        {list.map((c) => (
                          <div key={c.id} className="comm-line">
                            <span>{shortDate(c.date)}</span><span className="svc">{c.service}</span><span>{ROLE_TEXT[c.role] ?? c.role}</span>
                            <span className="num">{peso(c.paid)}</span><span className="num"><strong>{peso(c.amount)}</strong></span>
                          </div>
                        ))}
                      </div>
                    </details>
                  );
                })}
              </div>
            )}
            {run.state === "DRAFT" && slips.length > 0 && <FinalizeForm run={run.id} />}
            {run.state === "FINAL" && <p className="small muted" style={{ marginBottom: 0 }}>Staff can see their payslips under My payslips.</p>}
          </div>
        )}

        {colaWaiting.length > 0 && (
          <div className="card" id="cola">
            <h2>COLA changes waiting for an owner</h2>
            <ul className="plain-list">
              {colaWaiting.map((c) => (
                <li key={c.id} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <strong>{c.employees?.full_name}</strong><Uid v={c.employees?.uid ?? null} />
                  <span>{peso(c.old_cents)} → <strong>{peso(c.new_cents)}</strong> a month</span>
                  <span className="small muted">asked by {c.app_users?.display_name ?? "the GM"}</span>
                  {owner ? (
                    <>
                      <form action={decideCola}><input type="hidden" name="id" value={c.id} /><input type="hidden" name="approve" value="1" /><button className="small">Approve</button></form>
                      <form action={decideCola}><input type="hidden" name="id" value={c.id} /><input type="hidden" name="approve" value="0" /><button className="small secondary">Turn down</button></form>
                    </>
                  ) : <span className="small muted">Only an owner can approve.</span>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {thirteenth.length > 0 && (
          <div className="card">
            <h2>13th month pay ({year})</h2>
            <p className="muted small">
              A month&apos;s basic pay for the whole year, prorated from the start date for anyone who started after Jan 1, less unpaid absences on final payslips,
              divided the same way (÷ 12). Not taxed. Due by Dec 24. CSRs (contractors) aren&apos;t included. Set start dates on each employee&apos;s page.
            </p>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Name</th><th>Started</th><th className="num">Months</th><th className="num">Absences</th><th className="num">13th month</th></tr></thead>
                <tbody>
                  {thirteenth.map((t) => (
                    <tr key={t.employee_id}>
                      <td>{t.name}<Uid v={t.uid} /></td>
                      <td>{t.hire_date ? new Date(`${t.hire_date}T00:00:00Z`).toLocaleDateString("en-PH", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }) : <span className="small muted">no start date (full year)</span>}</td>
                      <td className="num">{Number(t.months).toFixed(t.prorated ? 2 : 0)}</td>
                      <td className="num">{Number(t.absences) ? peso(t.absences) : ""}</td>
                      <td className="num"><strong>{peso(t.amount)}</strong></td>
                    </tr>
                  ))}
                  <tr className="total"><td>Total</td><td></td><td></td><td></td><td className="num"><strong>{peso(thirteenth.reduce((a, t) => a + Number(t.amount), 0))}</strong></td></tr>
                </tbody>
              </table>
            </div>
            {run && run.state === "DRAFT" && Number(run.period_start.slice(0, 4)) === year && (
              <form action={addThirteenth} className="row-buttons">
                <input type="hidden" name="run" value={run.id} />
                <button className="secondary">Add 13th month to the {periodLabel(run.period_start)} payslips</button>
                <span className="small muted">Added once per person; remove it on a payslip if needed.</span>
              </form>
            )}
          </div>
        )}

        <div className="card">
          <h2>Pay rates</h2>
          <p className="muted small">
            Monthly: half is paid each cutoff, and a day&apos;s pay (for absences) is monthly ÷ 26. Daily: paid for days worked, paid leave and regular holidays.
            Allowance is per cutoff and not taxed. COLA is a month's amount, not taxed, paid in full on the 1st–15th cutoff; only an owner can set or approve it. A declared salary, if set, is what SSS, PhilHealth, Pag-IBIG and tax are based on. Lates are only deducted when ticked. Staff without a rate aren&apos;t in payroll{noRate.length > 0 ? ` (${noRate.length} without one yet)` : ""}.
          </p>
          <div className="pay-rates">
            {staff.map((e) => (
              <div key={e.id} className={`pay-rate-row${setting.has(e.id) ? "" : " missing"}`}>
                <div><strong>{e.full_name}</strong><Uid v={e.uid} /> <span className="small muted">{e.position ?? ""}</span></div>
                <PayRateForm employee={e.id} s={setting.get(e.id) ?? null} csr={(e.position ?? "").toUpperCase() === "CSR"} />
                {setting.has(e.id) && <ColaForm key={`${e.id}-${setting.get(e.id)?.cola_cents ?? 0}`} employee={e.id} cola={Number(setting.get(e.id)?.cola_cents ?? 0)} owner={owner} waiting={waitingFor.get(e.id) ?? null} />}
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <h2>Rules</h2>
          <RulesForm statutory={rules.statutory_cutoff ?? "FIRST"} special={rules.special_worked_premium ?? true} />
        </div>

        <div className="card">
          <h2>Holidays</h2>
          <p className="muted small">Regular holiday worked: +100% of a day&apos;s pay; a regular holiday off is still paid. Special day: no work, no pay; working it adds +30% (switch under Rules). CSRs get basic pay only, no holiday extras.</p>
          <HolidayForm />
          <ul className="plain-list">
            {(hols ?? []).map((h: { holiday_date: string; name: string; kind: string }) => (
              <li key={h.holiday_date}>
                <form action={deleteHoliday} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <input type="hidden" name="date" value={h.holiday_date} />
                  <span>{new Date(`${h.holiday_date}T00:00:00Z`).toLocaleDateString("en-PH", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric" })}</span>
                  <strong>{h.name}</strong><span className="small muted">{h.kind === "REGULAR" ? "Regular" : "Special"}</span>
                  <button className="secondary small">Remove</button>
                </form>
              </li>
            ))}
          </ul>
        </div>
      </main>
    </>
  );
}
