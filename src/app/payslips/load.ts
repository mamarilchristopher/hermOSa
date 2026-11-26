import type { SupabaseClient } from "@supabase/supabase-js";
import type { Payslip } from "@/lib/payroll";

type Row = Omit<Payslip, "name" | "uid" | "position" | "period_start" | "period_end" | "state" | "hire_date" | "branch"> & {
  employee_id: string; run_id: string;
  employees: { full_name: string; uid: string | null; position: string | null; hire_date: string | null; branches: { name: string } | null } | null;
  payroll_runs: { period_start: string; period_end: string; state: "DRAFT" | "FINAL" } | null;
};

const COLS = "id, run_id, employee_id, slip_no, basis, rate_cents, earnings, deductions, commissions, attendance, gross_cents, deductions_cents, net_cents, employees(full_name, uid, position, hire_date, branches(name)), payroll_runs(period_start, period_end, state)";

const shape = (r: Row): Payslip & { employee_id: string; run_id: string } => ({
  ...r, name: r.employees?.full_name ?? "", uid: r.employees?.uid ?? null, position: r.employees?.position ?? null,
  hire_date: r.employees?.hire_date ?? null, branch: r.employees?.branches?.name ?? null,
  period_start: r.payroll_runs?.period_start ?? "", period_end: r.payroll_runs?.period_end ?? "", state: r.payroll_runs?.state ?? "DRAFT",
  gross_cents: Number(r.gross_cents), deductions_cents: Number(r.deductions_cents), net_cents: Number(r.net_cents), rate_cents: Number(r.rate_cents),
});

/** One payslip the signed-in person may see (RLS: payroll staff, or their own once final), with the employee's
 *  government numbers from their approved details when the viewer may read them (owners, GM, self). */
export async function loadPayslip(supabase: SupabaseClient, id: string) {
  const { data } = await supabase.from("payslips").select(COLS).eq("id", id).maybeSingle();
  if (!data) return null;
  const p = shape(data as unknown as Row);
  const { data: det } = await supabase.from("employee_details").select("data").eq("employee_id", p.employee_id).maybeSingle();
  const d = (det?.data ?? {}) as Record<string, string>;
  return { ...p, gov: { tin: d.tin, sss: d.sss, philhealth: d.philhealth, pagibig: d.pagibig } };
}

/** The signed-in person's own final payslips, newest first. */
export async function loadMyPayslips(supabase: SupabaseClient, employeeId: string) {
  const { data } = await supabase.from("payslips").select(COLS).eq("employee_id", employeeId);
  return ((data ?? []) as unknown as Row[]).map(shape).filter((p) => p.state === "FINAL").sort((a, b) => b.period_start.localeCompare(a.period_start));
}
