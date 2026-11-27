import { AddPanel } from "@/components/Controls";
import Link from "next/link";
import { notFound } from "next/navigation";
import { can, requireAccess } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { Uid } from "@/components/Uid";
import { loadPayslip } from "../load";
import { peso, periodLabel, shortDate, longDate, ROLE_TEXT } from "@/lib/payroll";
import { PayslipTools } from "./PayslipTools";
import { AdjustmentForm } from "@/app/payroll/Forms";
import { removeAdjustment } from "@/app/payroll/actions";

/** One payslip, laid out like the paper slip, with the commission breakdown. */
export default async function PayslipPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const { supabase, access } = await requireAccess();
  const p = await loadPayslip(supabase, id);
  if (!p) notFound();
  const payroll = can(access, ["OWNER"], null) || can(access, ["MANAGER"], null);
  const editable = payroll && p.state === "DRAFT";
  const a = p.attendance;
  const Lines = ({ list }: { list: typeof p.earnings }) => (
    <>
      {list.map((l, i) => (
        <tr key={i}>
          <td>{l.label}
            {editable && l.adjustment && (
              <form action={removeAdjustment} style={{ display: "inline" }}><input type="hidden" name="id" value={l.adjustment} /> <button className="link small">Remove</button></form>
            )}
          </td>
          <td className="num">{peso(l.amount)}</td>
        </tr>
      ))}
    </>
  );
  return (
    <>
      <TopBar access={access} />
      <main>
        <p className="small">{payroll ? <Link href={`/payroll?run=${p.run_id}`}>‹ Payroll</Link> : <Link href="/payslips">‹ My payslips</Link>}</p>
        <div className="card payslip">
          <div className="payslip-band">PAY SLIP{p.state === "DRAFT" && <span className="small"> · draft</span>}</div>
          <div className="payslip-head">
            <div><span className="muted small">No.</span> {p.slip_no}</div>
            <div><span className="muted small">Period</span> {periodLabel(p.period_start)}</div>
            <div><span className="muted small">Employee</span> {p.name}<Uid v={p.uid} /></div>
            <div><span className="muted small">Rate</span> {peso(p.rate_cents)} {p.basis === "MONTHLY" ? "a month" : "a day"}</div>
            <div><span className="muted small">Position</span> {p.position ?? "—"}</div>
            <div><span className="muted small">Branch</span> {p.branch ?? "—"}</div>
            <div><span className="muted small">Date hired</span> {longDate(p.hire_date)}</div>
            <div><span className="muted small">Paid by</span> Cash</div>
          </div>
          <table className="payslip-table">
            <tbody>
              <tr className="sec"><th colSpan={2}>Earnings</th></tr>
              <Lines list={p.earnings} />
              <tr className="total"><td>Total salary</td><td className="num">{peso(p.gross_cents)}</td></tr>
              <tr className="sec"><th colSpan={2}>Less deductions</th></tr>
              {p.deductions.length === 0 && <tr><td className="muted">None</td><td className="num">{peso(0)}</td></tr>}
              <Lines list={p.deductions} />
              <tr className="total"><td>Total deductions</td><td className="num">{peso(p.deductions_cents)}</td></tr>
              <tr className="net"><td>Net salary</td><td className="num">{peso(p.net_cents)}</td></tr>
            </tbody>
          </table>
          <p className="small muted">
            Days worked {a.worked ?? 0} · paid leave {a.paid_leave ?? 0} · unpaid leave {a.unpaid_leave ?? 0} · absent {a.absent ?? 0} · late {a.late_min ?? 0} min after grace
            {a.daily_rate ? ` · a day's pay ${peso(a.daily_rate)}` : ""}
          </p>
          <PayslipTools p={p} />
          <p className="small muted no-print">The photo and PDF have the details on page 1{p.commissions.length > 0 ? " and every commission on the next page(s). Copy as photo copies page 1" : ""}.</p>
        </div>

        {p.commissions.length > 0 && (
          <div className="card">
            <h2>Commission details ({p.commissions.length})</h2>
            <p className="muted small">Signed-off services up to the end of this cutoff that weren&apos;t paid before.</p>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Date</th><th>Service</th><th>Role</th><th className="num">Amount paid</th><th className="num">Commission</th></tr></thead>
                <tbody>
                  {p.commissions.map((c) => (
                    <tr key={c.id}><td>{shortDate(c.date)}</td><td>{c.service}</td><td>{ROLE_TEXT[c.role] ?? c.role}</td><td className="num">{peso(c.paid)}</td><td className="num">{peso(c.amount)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {editable && (
          <AddPanel title="Add a line" hint="Overtime, bonus, cash advance, loan">
            <p className="muted small" style={{ marginTop: 0 }}>Overtime, holiday pay not on the schedule, bonuses, cash advances, SSS or Pag-IBIG loans, personal loans. Write the installment in the label, like &quot;(2nd deduction)&quot;.</p>
            <AdjustmentForm run={p.run_id} employee={p.employee_id} />
          </AddPanel>
        )}
      </main>
    </>
  );
}
