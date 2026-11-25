import type { SupabaseClient } from "@supabase/supabase-js";
import type { Payslip } from "@/lib/payroll";

type Row = Omit<Payslip, "name" | "uid" | "position" | "period_start" | "period_end" | "state"> & {
  employee_id: string; run_id: string;
  employees: { full_name: string; uid: string | null; position: string | null } | null;
  payroll_runs: { period_start: string; period_end: string; state: "DRAFT" | "FINAL" } | null;
};

const COLS = "id, run_id, employee_id, slip_no, basis, rate_cents, earnings, deductions, commissions, attendance, gross_cents, deductions_cents, net_cents, employees(full_name, uid, position), payroll_runs(period_start, period_end, state)";

const shape = (r: Row): Payslip & { employee_id: string; run_id: string } => ({
  ...r, name: r.employees?.full_name ?? "", uid: r.employees?.uid ?? null, position: r.employees?.position ?? null,
  period_start: r.payroll_runs?.period_start ?? "", period_end: r.payroll_runs?.period_end ?? "", state: r.payroll_runs?.state ?? "DRAFT",
  gross_cents: Number(r.gross_cents), deductions_cents: Number(r.deductions_cents), net_cents: Number(r.net_cents), rate_cents: Number(r.rate_cents),
});

/** One payslip the signed-in person may see (RLS: payroll staff, or their own once final). */
export async function loadPayslip(supabase: SupabaseClient, id: string) {
  const { data } = await supabase.from("payslips").select(COLS).eq("id", id).maybeSingle();
  return data ? shape(data as unknown as Row) : null;
}

/** The signed-in person's own final payslips, newest first. */
export async function loadMyPayslips(supabase: SupabaseClient, employeeId: string) {
  const { data } = await supabase.from("payslips").select(COLS).eq("employee_id", employeeId);
  return ((data ?? []) as unknown as Row[]).map(shape).filter((p) => p.state === "FINAL").sort((a, b) => b.period_start.localeCompare(a.period_start));
}
