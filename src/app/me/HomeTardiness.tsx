import Link from "next/link";
import { dayLabel } from "@/lib/homeGlance";
import { firstName, nteCount, type Nte, type TrackerRow, nteId } from "@/lib/nte";
import { Uid } from "@/components/Uid";
import { PingNteButton } from "@/app/nte/Forms";

/** Where a Late NTE stands, in CHRIS's words: Accepted reason / Rejected reason (with the reviewer's note). */
function nteStatus(n: Nte): { label: string; tone: "good" | "bad" | "wait" | "muted" } {
  if (n.state === "VOID") return { label: "Voided", tone: "muted" };
  if (n.state === "ACCEPTED" || n.review === "ACCEPTED") return { label: "Accepted reason", tone: "good" };
  if (n.review === "REJECTED") return { label: "Rejected reason", tone: "bad" };
  if (n.ir_id) return { label: "In an IR", tone: "bad" };
  if (n.state === "EXPLAINED") return { label: "Reason to review", tone: "wait" };
  return { label: "Not explained yet", tone: "wait" };
}

/** CHRIS Nov 26: the Tardiness tracker on Home lists every Late NTE issued this month with its status and note. */
export function HomeTardiness({ month, ntes, people }: { month: string; ntes: Nte[]; people: TrackerRow[] }) {
  const list = ntes.filter((n) => n.can_manage);
  const due = people.filter((r) => r.due);
  return (
    <div className="card">
      <div className="card-head"><h2>Tardiness tracker, {month}</h2><span className="tdy-links"><Link className="button small" href="/nte/dashboard">Dashboard</Link><Link className="button secondary small" href="/nte">All Late NTEs</Link></span></div>
      {due.length > 0 && (
        <ul className="plain-list" style={{ marginBottom: 10 }}>
          {due.map((r) => (
            <li key={r.employee_id} className="ir-due">
              <span><strong>{firstName(r.name)}</strong><Uid v={r.uid} /> has {nteCount(r.count)} counted this month · <span className="small ir-due-tag">IR suggested: {r.due}</span></span>
              <Link className="button secondary small" href={`/nte/staff/${r.employee_id}`}>Open</Link>
            </li>
          ))}
        </ul>
      )}
      {list.length === 0 ? <p className="muted" style={{ margin: 0 }}>No Late NTEs issued this month.</p> : (
        <>
          <div className="table-wrap nte-track-wide">
          <table className="glance-table nte-track">
            <thead><tr><th>Date</th><th>Staff</th><th className="num">Late</th><th>Status</th><th>Reason and note</th></tr></thead>
            <tbody>
              {list.map((n) => {
                const s = nteStatus(n);
                return (
                  <tr key={n.id}>
                    <td className="nowrap">{dayLabel(n.work_date)}<br /><span className="small muted">{nteId(n.nte_no)}</span></td>
                    <td><Link href={`/nte/staff/${n.employee_id}`}>{firstName(n.name)}</Link>{n.branch && <><br /><span className="small muted">{n.branch}</span></>}</td>
                    <td className="num">{n.late_minutes} min</td>
                    <td><span className={`nte-st ${s.tone}`}>{s.label}</span></td>
                    <td className="small">
                      {n.explanation ? <>“{n.explanation.length > 140 ? `${n.explanation.slice(0, 140)}…` : n.explanation}”</> : <span className="muted">No reason yet</span>}
                      {n.review_note && <><br /><strong>Note:</strong> {n.review_note}</>}
                      {n.state === "VOID" && n.void_reason && <><br /><strong>Voided:</strong> {n.void_reason}</>}
                      {n.state === "OPEN" && !n.ir_id && <PingNteButton id={n.id} name={firstName(n.name)} />}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
          {/* Phones: one box per NTE so the status is always in view. */}
          <ul className="plain-list nte-track-list">
            {list.map((n) => {
              const s = nteStatus(n);
              return (
                <li key={n.id}>
                  <span><Link href={`/nte/staff/${n.employee_id}`}><strong>{firstName(n.name)}</strong></Link> · {dayLabel(n.work_date)} · {n.late_minutes} min late</span>
                  <span className={`nte-st ${s.tone}`}>{s.label}</span>
                  {n.explanation && <span className="small">“{n.explanation.length > 140 ? `${n.explanation.slice(0, 140)}…` : n.explanation}”</span>}
                  {n.review_note && <span className="small"><strong>Note:</strong> {n.review_note}</span>}
                  {n.state === "VOID" && n.void_reason && <span className="small"><strong>Voided:</strong> {n.void_reason}</span>}
                  {n.state === "OPEN" && !n.ir_id && <PingNteButton id={n.id} name={firstName(n.name)} />}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
