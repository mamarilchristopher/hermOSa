import Link from "next/link";
import { redirect } from "next/navigation";
import { can, requireAccess } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { Uid } from "@/components/Uid";
import { openPayroll, deleteHoliday, addThirteenth } from "./actions";
import { FinalizeForm, HolidayForm, PayRateForm, RulesForm, type PaySetting } from "./Forms";
import { peso, periodLabel, manilaToday } from "@/lib/payroll";

type Run = { id: string; period_start: string; period_end: string; state: "DRAFT" | "FINAL"; computed_at: string | null; finalized_at: string | null };
type Slip = { id: string; employee_id: string; slip_no: string; gross_cents: number; deductions_cents: number; net_cents: number;
  earnings: { label: string; amount: number }[]; employees: { full_name: string; uid: string | null } | null };
type Emp = { id: string; uid: string | null; full_name: string; position: string | null };

/** Payroll per cutoff (update-0046). Owners and the GM. */
export default async function PayrollPage({ searchParams }: { searchParams: Promise<{ run?: string }> }) {
  const { supabase, access } = await requireAccess();
  if (!can(access, ["OWNER"], null) && !can(access, ["MANAGER"], null)) redirect("/payslips");
  const { run: runParam } = await searchParams;
  const today = manilaToday();
  const lastCutoff = Number(today.slice(8, 10)) <= 15
    ? new Date(Date.parse(`${today.slice(0, 7)}-01T00:00:00Z`) - 86400000).toISOString().slice(0, 10)
    : `${today.slice(0, 7)}-01`;

  const [{ data: runsData, error: runsErr }, { data: emps }, { data: settings }, { data: hols }, { data: org }] = await Promise.all([
    supabase.from("payroll_runs").select("id, period_start, period_end, state, computed_at, finalized_at").order("period_start", { ascending: false }).limit(24),
    supabase.from("employees").select("id, uid, full_name, position").eq("active", true).order("full_name"),
    supabase.from("pay_settings").select("employee_id, basis, rate_cents, allowance_cents, statutory, tax, deduct_lates, declared_cents"),
    supabase.from("holidays").select("holiday_date, name, kind").gte("holiday_date", `${Number(today.slice(0, 4)) - 1}-12-01`).order("holiday_date"),
    supabase.from("organizations").select("payroll_rules").maybeSingle(),
  ]);
  const rules = ((org as { payroll_rules?: { statutory_cutoff?: string; special_worked_premium?: boolean } } | null)?.payroll_rules) ?? {};
  const runs = (runsData ?? []) as Run[];
  const run = runs.find((r) => r.id === runParam) ?? runs[0] ?? null;
  const { data: slipsData } = run
    ? await supabase.from("payslips").select("id, employee_id, slip_no, gross_cents, deductions_cents, net_cents, earnings, employees(full_name, uid)").eq("run_id", run.id)
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

        <div className="card">
          <h2>Cutoff</h2>
          <div className="row-buttons">
            <form action={openPayroll}><input type="hidden" name="date" value={lastCutoff} /><button className="secondary">Open {periodLabel(lastCutoff)}</button></form>
            <form action={openPayroll}><input type="hidden" name="date" value={today} /><button className="secondary">Open {periodLabel(today)} (so far)</button></form>
          </div>
          {runs.length > 0 && (
            <p className="small" style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 0 }}>
              {runs.map((r) => (
                <Link key={r.id} href={`/payroll?run=${r.id}`} className={`chip${run?.id === r.id ? " on" : ""}`}>
                  {periodLabel(r.period_start)} · {r.state === "FINAL" ? "Final" : "Draft"}
                </Link>
              ))}
            </p>
          )}
        </div>

        {run && (
          <div className="card">
            <h2>{periodLabel(run.period_start)} <span className={`pill ${run.state === "FINAL" ? "PUBLISHED" : "STAGED"}`}>{run.state === "FINAL" ? "Final" : "Draft"}</span></h2>
            {run.state === "DRAFT" && (
              <form action={openPayroll} className="small muted" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <input type="hidden" name="date" value={run.period_start} />
                Worked out {run.computed_at ? new Date(run.computed_at).toLocaleString("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "not yet"}.
                <button className="secondary small">Recompute now</button>
              </form>
            )}
            {slips.length === 0 && <p className="muted small">No payslips. Set pay rates below first.</p>}
            {slips.length > 0 && (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Name</th><th className="num">Commission</th><th className="num">Gross</th><th className="num">Deductions</th><th className="num">Net pay</th><th></th></tr></thead>
                  <tbody>
                    {slips.map((s) => (
                      <tr key={s.id}>
                        <td>{s.employees?.full_name}<Uid v={s.employees?.uid ?? null} /></td>
                        <td className="num">{peso(comm(s))}</td>
                        <td className="num">{peso(s.gross_cents)}</td>
                        <td className="num">{peso(s.deductions_cents)}</td>
                        <td className="num"><strong>{peso(s.net_cents)}</strong></td>
                        <td><Link href={`/payslips/${s.id}`}>{run.state === "DRAFT" ? "Check / add lines" : "Payslip"}</Link></td>
                      </tr>
                    ))}
                    <tr className="total"><td>Total ({slips.length})</td><td></td><td className="num">{peso(sum("gross_cents"))}</td><td className="num">{peso(sum("deductions_cents"))}</td><td className="num"><strong>{peso(sum("net_cents"))}</strong></td><td></td></tr>
                  </tbody>
                </table>
              </div>
            )}
            {run.state === "DRAFT" && slips.length > 0 && <FinalizeForm run={run.id} />}
            {run.state === "FINAL" && <p className="small muted">Finalized {run.finalized_at ? new Date(run.finalized_at).toLocaleString("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""}. Staff can see their payslips under My payslips.</p>}
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
            Allowance is per cutoff and not taxed. A declared salary, if set, is what SSS, PhilHealth, Pag-IBIG and tax are based on. Lates are only deducted when ticked. Staff without a rate aren&apos;t in payroll{noRate.length > 0 ? ` (${noRate.length} without one yet)` : ""}.
          </p>
          <div className="pay-rates">
            {staff.map((e) => (
              <div key={e.id} className={`pay-rate-row${setting.has(e.id) ? "" : " missing"}`}>
                <div><strong>{e.full_name}</strong><Uid v={e.uid} /> <span className="small muted">{e.position ?? ""}</span></div>
                <PayRateForm employee={e.id} s={setting.get(e.id) ?? null} csr={(e.position ?? "").toUpperCase() === "CSR"} />
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
