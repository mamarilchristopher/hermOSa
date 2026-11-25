import { Fragment } from "react";
import { dayLabel } from "@/lib/homeGlance";
import { monthLabel } from "@/lib/insights";
import { timeLabel } from "@/lib/schedule";
import { minutesText, type Ir } from "@/lib/incidents";
import { AckForm, CloseForm } from "./Forms";

const when = (ts: string | null) => ts ? new Date(ts).toLocaleString("en-PH", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Manila" }) : "";

/** The IR itself, laid out to print in black and white. Forms show in place of blanks for whoever acts next. */
export function IrDocument({ r }: { r: Ir }) {
  const nte = r.basis === "LATE_NTE";
  return (
    <article className="card ir-doc">
          <header className="ir-head">
            <img src="/hermosa-logo-transparent.png" alt="Hermosa Aesthetics" className="ir-logo" />
            <div><h1>Incident Report</h1><div className="small">IR no. {r.ir_no} · Tardiness</div></div>
          </header>
          <table className="ir-fields">
            <tbody>
              <tr><th>Employee</th><td>{r.name}</td><th>Position</th><td>{r.position ?? ""}</td></tr>
              <tr><th>Branch</th><td>{r.branch ?? ""}</td><th>Date issued</th><td>{r.issued_at ? dayLabel(r.issued_at.slice(0, 10)) : "Not issued yet"}</td></tr>
              <tr><th>Covered period</th><td colSpan={3}>{nte ? `${monthLabel(r.period_start.slice(0, 7))} (Late NTEs not in an earlier IR)` : `${dayLabel(r.period_start)} to ${dayLabel(r.period_end)} (payroll cutoff)`}</td></tr>
            </tbody>
          </table>

          <h2>Incident</h2>
          <p>{nte
            ? <>Late {r.late_days} time{r.late_days === 1 ? "" : "s"} this month, {minutesText(r.late_minutes)} in total. A Late NTE was issued for each. Times are from the Hermosa OS time clock.</>
            : <>Late {r.late_days} time{r.late_days === 1 ? "" : "s"} in this cutoff, {minutesText(r.late_minutes)} in total. The limit is {r.limit_minutes} minutes per cutoff. Times are from the Hermosa OS time clock.</>}</p>
          <table className="ir-days">
            <thead><tr><th>Date</th>{nte && <th>NTE no.</th>}<th>Branch</th><th>Shift start</th><th>Time in</th><th>Minutes late</th></tr></thead>
            <tbody>
              {r.details.map((d) => (
                <Fragment key={d.date}>
                  <tr><td>{dayLabel(d.date)}</td>{nte && <td>{d.nte_no ?? ""}</td>}<td>{d.branch ?? ""}</td><td>{timeLabel(d.start)}</td><td>{timeLabel(d.time_in)}</td><td>{d.late_min}</td></tr>
                  {nte && d.explanation && <tr className="ir-nte-why"><td colSpan={6}>NTE explanation: {d.explanation}</td></tr>}
                </Fragment>
              ))}
              <tr className="total"><td colSpan={nte ? 5 : 4}>Total</td><td>{r.late_minutes}</td></tr>
            </tbody>
          </table>
          {r.issue_note && <><h2>Note from management</h2><p>{r.issue_note}</p></>}

          <h2>Employee acknowledgement and response</h2>
          {r.explanation ? <p className="ir-text">{r.acknowledged_at && <><strong>Acknowledged online on {when(r.acknowledged_at)}.</strong><br /></>}{r.explanation}<br /><span className="small muted">{when(r.explained_at)}</span></p>
            : r.mine && r.state === "ISSUED" ? <AckForm id={r.id} /> : <div className="ir-blank" />}

          <h2>Action taken</h2>
          {r.action_taken ? <p className="ir-text">{r.action_taken}<br /><span className="small muted">{r.closed_by} · {when(r.closed_at)}</span></p>
            : r.can_manage && (r.state === "ISSUED" || r.state === "EXPLAINED") ? <CloseForm id={r.id} /> : <div className="ir-blank" />}

          <div className="ir-sign">
            <div><span className="line" />Employee signature over printed name</div>
            <div><span className="line" />Issued by{r.issued_by ? `: ${r.issued_by}` : ""}</div>
          </div>
        </article>
  );
}
