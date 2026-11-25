// update-0046: payroll and payslips. All people and amounts are DEMO fixtures.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, gm: Person, lead: Person, ana: Person, bea: Person;
let anaE: string, beaE: string, FV: string, svc: string, run: string;
type Line = { label: string; amount: number };

beforeAll(async () => {
  db = await TestDb.create();
  FV = db.branches.FAIRVIEW;
  owner = await db.person("Owner", [["OWNER", null]]);
  gm = await db.person("General Manager", [["MANAGER", null]]);
  lead = await db.person("Branch Lead", [["MANAGER", "FAIRVIEW"]]);
  ana = await db.person("Ana", [["CLINICIAN", "FAIRVIEW"]]);
  bea = await db.person("Bea", [["CLINICIAN", "FAIRVIEW"]]);
  anaE = (await db.rpc(owner, "aal2", "save_employee", [null, FV, "DEMO Ana", "CMA", true, ana.appUserId, true])).id;
  beaE = (await db.rpc(owner, "aal2", "save_employee", [null, FV, "DEMO Bea", "CMA", true, bea.appUserId, true])).id;
  await db.sql("UPDATE public.organizations SET late_grace_minutes = 15");
  svc = (await db.rpc(lead, "aal1", "add_service", ["DEMO Facial"])).id;
}, 60_000);
afterAll(async () => db?.close());

async function shift(emp: string, d: string, off = false, leave: string | null = null) {
  await db.sql(`INSERT INTO public.shifts (organization_id, employee_id, work_date, branch_id, start_time, end_time, is_off, leave_type, state, updated_by)
    SELECT organization_id, id, $2, CASE WHEN $5 THEN NULL ELSE $3::uuid END, CASE WHEN $5 THEN NULL ELSE '10:00'::time END, CASE WHEN $5 THEN NULL ELSE '19:00'::time END,
      $5, $6, 'PUBLISHED', $4 FROM public.employees WHERE id = $1`, [emp, d, FV, gm.appUserId, off, leave]);
}
async function timeIn(emp: string, user: Person, d: string, hhmm: string) {
  await db.sql(`INSERT INTO public.time_punches (organization_id, employee_id, user_id, branch_id, kind, punched_at, work_date)
    SELECT organization_id, id, $2, $3, 'IN', ($4 || ' ' || $5)::timestamp AT TIME ZONE 'Asia/Manila', $4::date FROM public.employees WHERE id = $1`,
    [emp, user.appUserId, FV, d, hhmm]);
}
const slip = async (emp: string) => (await db.sql("SELECT * FROM public.payslips WHERE run_id = $1 AND employee_id = $2", [run, emp])).rows[0];
const amt = (lines: Line[], start: string) => lines.find((l) => l.label.startsWith(start))?.amount;

describe("payroll", () => {
  it("only owners and the GM set pay rates and open payroll", async () => {
    expect((await db.rpc(lead, "aal1", "save_pay_settings", [anaE, "MONTHLY", 2_000_000, 0, true, true, true, null])).ok).toBe(false);
    expect((await db.rpc(ana, "aal1", "open_payroll", ["2026-10-01"])).ok).toBe(false);
    expect((await db.rpc(owner, "aal2", "save_pay_settings", [anaE, "MONTHLY", 2_000_000, 50_000, true, true, true, null])).ok).toBe(true);
    expect((await db.rpc(gm, "aal1", "save_pay_settings", [beaE, "DAILY", 60_000, 0, false, false, true, null])).ok).toBe(true);
    expect((await db.rpc(gm, "aal1", "save_holiday", ["2026-10-10", "DEMO Holiday", "REGULAR"])).ok).toBe(true);
  });

  it("monthly pay: half salary, absence and lates deducted, paid leave kept, commission and government shares", async () => {
    for (const d of ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]) await shift(anaE, d);
    await shift(anaE, "2026-10-05", true, "VL");
    await db.sql(`INSERT INTO public.leave_requests (organization_id, employee_id, kind, start_date, end_date, reason, state, with_pay, days, filed_by)
      SELECT organization_id, id, 'VL', '2026-10-05', '2026-10-05', 'DEMO trip', 'APPROVED', true, 1, $2 FROM public.employees WHERE id = $1`, [anaE, ana.appUserId]);
    await timeIn(anaE, ana, "2026-10-01", "09:55");
    await timeIn(anaE, ana, "2026-10-02", "10:10"); // inside the 15-minute grace
    await timeIn(anaE, ana, "2026-10-03", "10:55"); // 55 min late -> 40 min after grace
    // 2026-10-04: no time-in -> absent
    const log = await db.rpc(lead, "aal1", "log_service", [FV, "2026-10-02", svc, 1_000_000, "SOLO", anaE, null, null, null]);
    expect((await db.rpc(owner, "aal2", "decide_service_log", [log.id, true, null])).ok).toBe(true);

    const o = await db.rpc(gm, "aal1", "open_payroll", ["2026-10-07"]);
    expect(o).toMatchObject({ ok: true, state: "DRAFT" });
    run = o.id;
    const s = await slip(anaE);
    const daily = 2_000_000 / 26;
    expect(amt(s.earnings, "Basic pay")).toBe(1_000_000);
    expect(amt(s.earnings, "Commission")).toBe(50_000);
    expect(amt(s.earnings, "Allowance")).toBe(50_000);
    expect(amt(s.deductions, "Absences")).toBe(Math.round(daily));
    expect(s.deductions.find((l: Line) => l.label.startsWith("Absences")).label).toContain("Oct 4");
    expect(amt(s.deductions, "Lates (40 min)")).toBe(Math.round((daily / 480) * 40));
    expect(amt(s.deductions, "SSS")).toBe(100_000);       // P1,000 a month for a P20,000 credit, all on the 1st-15th cutoff
    expect(amt(s.deductions, "PhilHealth")).toBe(50_000); // 2.5% of P20,000
    expect(amt(s.deductions, "Pag-IBIG")).toBe(20_000);   // P200 a month
    expect(amt(s.deductions, "Withholding")).toBeUndefined(); // below the taxable line
    expect(s.attendance).toMatchObject({ worked: 3, paid_leave: 1, absent: 1, late_min: 40 });
    expect(Number(s.net_cents)).toBe(Number(s.gross_cents) - Number(s.deductions_cents));
    expect(s.commissions).toHaveLength(1);
  });

  it("daily pay: days worked plus regular holiday worked at double; switches off government shares", async () => {
    await shift(beaE, "2026-10-09"); await timeIn(beaE, bea, "2026-10-09", "10:00");
    await shift(beaE, "2026-10-10"); await timeIn(beaE, bea, "2026-10-10", "10:00");
    await db.rpc(gm, "aal1", "open_payroll", ["2026-10-01"]);
    const s = await slip(beaE);
    expect(amt(s.earnings, "Basic pay (2 days)")).toBe(120_000);
    expect(amt(s.earnings, "Regular holiday worked")).toBe(60_000);
    expect(amt(s.deductions, "SSS")).toBeUndefined();
  });

  it("hand-added lines; staff can't see a draft; tax kicks in on high pay", async () => {
    const a = await db.rpc(gm, "aal1", "add_payslip_adjustment", [run, beaE, "EARNING", "Overtime 3 hrs", 22_500, true]);
    expect(a.ok).toBe(true);
    expect(await db.rpc(gm, "aal1", "add_payslip_adjustment", [run, beaE, "DEDUCTION", "Cash advance Oct 3 (1st deduction)", 50_000, true])).toMatchObject({ ok: true });
    expect(amt((await slip(beaE)).earnings, "Overtime")).toBe(22_500);
    expect((await db.rpc(lead, "aal1", "remove_payslip_adjustment", [a.id])).ok).toBe(false);
    expect((await db.as(bea, "aal1", "SELECT count(*)::int AS n FROM public.payslips")).rows[0].n).toBe(0);
    const tax = await db.sql("SELECT private.wtax_semi(2000000) AS t, private.wtax_semi(1000000) AS z");
    expect(Number(tax.rows[0].t)).toBe(93_750 + Math.round((2_000_000 - 1_666_700) * 0.2));
    expect(Number(tax.rows[0].z)).toBe(0);
  });

  it("finalize: locked, staff see only their own, notified, and each commission is paid once", async () => {
    expect((await db.rpc(lead, "aal1", "finalize_payroll", [run])).ok).toBe(false);
    expect(await db.rpc(owner, "aal2", "finalize_payroll", [run])).toMatchObject({ ok: true, payslips: 2 });
    expect((await db.rpc(gm, "aal1", "add_payslip_adjustment", [run, beaE, "EARNING", "Late add", 100, true])).error).toBe("PAYROLL_IS_FINAL");
    await expect(db.sql("UPDATE public.payslips SET net_cents = 1 WHERE run_id = $1", [run])).rejects.toThrow(/PAYROLL_IS_FINAL/);
    const mine = await db.as(ana, "aal1", "SELECT employee_id FROM public.payslips");
    expect(mine.rows.map((r) => r.employee_id)).toEqual([anaE]);
    const n = await db.sql("SELECT count(*)::int AS n FROM public.notifications WHERE kind = 'PAYSLIP_READY'");
    expect(n.rows[0].n).toBe(2);
    const next = await db.rpc(gm, "aal1", "open_payroll", ["2026-10-20"]);
    const s2 = (await db.sql("SELECT * FROM public.payslips WHERE run_id = $1 AND employee_id = $2", [next.id, anaE])).rows[0];
    expect(s2.commissions).toEqual([]);
  });

  it("update-0047 rules: declared salary for government shares, none on the 16th-end cutoff, special day +30% except CSRs", async () => {
    expect((await db.rpc(gm, "aal1", "save_pay_settings", [anaE, "MONTHLY", 2_750_000, 0, true, true, false, 1_482_000])).ok).toBe(true);
    const o = await db.rpc(gm, "aal1", "open_payroll", ["2026-09-01"]);
    const s = (await db.sql("SELECT * FROM public.payslips WHERE run_id = $1 AND employee_id = $2", [o.id, anaE])).rows[0];
    expect(amt(s.earnings, "Basic pay")).toBe(1_375_000);
    expect(amt(s.deductions, "SSS")).toBe(75_000);       // P14,820 declared -> P15,000 credit -> P750
    expect(amt(s.deductions, "PhilHealth")).toBe(37_050); // 2.5% of P14,820
    expect(amt(s.deductions, "Withholding")).toBeUndefined(); // taxed on half the declared salary
    const second = await db.rpc(gm, "aal1", "open_payroll", ["2026-09-20"]);
    const s2 = (await db.sql("SELECT * FROM public.payslips WHERE run_id = $1 AND employee_id = $2", [second.id, anaE])).rows[0];
    expect(amt(s2.deductions, "SSS")).toBeUndefined();

    await db.rpc(gm, "aal1", "save_holiday", ["2026-09-08", "DEMO Special", "SPECIAL"]);
    await shift(beaE, "2026-09-08"); await timeIn(beaE, bea, "2026-09-08", "10:00");
    await db.rpc(gm, "aal1", "open_payroll", ["2026-09-01"]);
    let b = (await db.sql("SELECT * FROM public.payslips WHERE run_id = $1 AND employee_id = $2", [o.id, beaE])).rows[0];
    expect(amt(b.earnings, "Special day worked")).toBe(18_000); // +30% (CHRIS: x1.3 for all staff except CSRs)
    await db.sql("UPDATE public.employees SET position = 'CSR' WHERE id = $1", [beaE]);
    await db.rpc(gm, "aal1", "open_payroll", ["2026-09-01"]);
    b = (await db.sql("SELECT * FROM public.payslips WHERE run_id = $1 AND employee_id = $2", [o.id, beaE])).rows[0];
    expect(amt(b.earnings, "Special day worked")).toBeUndefined(); // CSRs: basic pay only
    await db.sql("UPDATE public.employees SET position = 'CMA' WHERE id = $1", [beaE]);
    expect((await db.rpc(lead, "aal1", "save_payroll_rules", ["SPLIT", false])).ok).toBe(false);
    expect((await db.rpc(owner, "aal2", "save_payroll_rules", ["FIRST", false])).ok).toBe(true);
    await db.rpc(gm, "aal1", "open_payroll", ["2026-09-01"]);
    b = (await db.sql("SELECT * FROM public.payslips WHERE run_id = $1 AND employee_id = $2", [o.id, beaE])).rows[0];
    expect(amt(b.earnings, "Special day worked")).toBeUndefined();
  });

  it("13th month: a month's pay for the full year, prorated from a start date in the year, less unpaid absences; CSRs excluded", async () => {
    await db.sql("UPDATE public.employees SET hire_date = '2025-03-01' WHERE id = $1", [anaE]);
    await db.sql("UPDATE public.employees SET hire_date = '2026-07-01' WHERE id = $1", [beaE]);
    const list = await db.rpc(gm, "aal1", "thirteenth_month", [2026]);
    const a = list.find((x: { employee_id: string }) => x.employee_id === anaE), b = list.find((x: { employee_id: string }) => x.employee_id === beaE);
    expect(a.prorated).toBe(false);
    expect(a.amount).toBe(Math.round((2_750_000 * 12 - Number(a.absences)) / 12));
    expect(Number(a.absences)).toBeGreaterThan(0); // the Oct 4 absence on the final Oct 1-15 payslip
    expect(b.prorated).toBe(true);
    expect(Number(b.months)).toBeCloseTo((184 * 12) / 365, 1);
    expect(await db.rpc(ana, "aal1", "thirteenth_month", [2026])).toEqual([]);
    const dec = await db.rpc(gm, "aal1", "open_payroll", ["2026-12-01"]);
    expect(await db.rpc(gm, "aal1", "add_thirteenth_month", [dec.id])).toMatchObject({ ok: true, added: 2 });
    expect(await db.rpc(gm, "aal1", "add_thirteenth_month", [dec.id])).toMatchObject({ ok: true, added: 0 });
    const s = (await db.sql("SELECT * FROM public.payslips WHERE run_id = $1 AND employee_id = $2", [dec.id, anaE])).rows[0];
    expect(amt(s.earnings, "13th month pay 2026")).toBe(a.amount);
    await db.sql("UPDATE public.employees SET position = 'CSR' WHERE id = $1", [beaE]);
    expect((await db.rpc(gm, "aal1", "thirteenth_month", [2026])).find((x: { employee_id: string }) => x.employee_id === beaE)).toBeUndefined();
    await db.sql("UPDATE public.employees SET position = 'CMA' WHERE id = $1", [beaE]);
  });

  it("a cutoff that hasn't ended can't be finalized", async () => {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());
    const o = await db.rpc(gm, "aal1", "open_payroll", [today]);
    const end = (await db.sql("SELECT period_end::text AS e FROM public.payroll_runs WHERE id = $1", [o.id])).rows[0].e;
    if (end > today) expect((await db.rpc(gm, "aal1", "finalize_payroll", [o.id])).error).toBe("CUTOFF_NOT_OVER");
  });
});
