import Link from "next/link";
import { centsToPhp } from "@/lib/csv";
import { monthLabel } from "@/lib/insights";
import { dayLabel, type DayCell, type Glance } from "@/lib/homeGlance";
import type { DutyRow } from "@/components/OnDuty";
import { OnDutyFaces, type DutyFace } from "@/components/OnDutyFaces";

export type Todo = { text: string; href: string; urgent?: boolean };

const php = (c: number) => centsToPhp(Math.round(c / 100) * 100).replace(/\.00$/, "");
function Delta({ v, title }: { v: number | null; title?: string }) {
  if (v === null || !Number.isFinite(v)) return null;
  const r = Math.round(v * 100);
  return <span className={`delta ${r >= 0 ? "up" : "down"}`} title={title}>{r >= 0 ? "▲" : "▼"} {Math.abs(r)}%</span>;
}
function Cell({ c }: { c: DayCell }) {
  switch (c.kind) {
    case "sales": return <>{php(c.cents)}</>;
    case "zero": return <span className="muted">Zero sales</span>;
    case "closed": return <span className="muted">Closed</span>;
    case "waiting": return <span className="pill STAGED">Waiting sign-off</span>;
    default: return <span className="pill REVERSED">Not entered</span>;
  }
}

/** What needs doing, each with an Open button to the page where it's done. Red dot = urgent. */
export function TodoCard({ todos }: { todos: Todo[] }) {
  return (
    <div className="card todo">
        <h2>To do{todos.length > 0 && <span className="nav-badge inline">{todos.length}</span>}</h2>
        {todos.length === 0 ? <p className="muted" style={{ margin: 0 }}>All caught up. Nothing is waiting on you.</p> : (
          <ul className="plain-list todo-list">
            {todos.map((t) => (
              <li key={t.text} className={t.urgent ? "urgent" : ""}>
                <span>{t.text}</span><Link className="button secondary small" href={t.href}>Open</Link>
              </li>
            ))}
          </ul>
        )}
      </div>
  );
}

/** Home for owners, finance and managers: what needs doing, yesterday per branch, and how the month is going. */
export function ManagerHome({ g, duty, faces = {}, branches }: { g: Glance; duty: DutyRow[] | null; faces?: Record<string, DutyFace>; branches: { id: string; name: string }[] }) {
  const ym = g.today.slice(0, 7);
  const hm = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Manila" });
  const entered = g.branches.filter((b) => b.todayCell.kind !== "empty").length;
  // CHRIS (Nov 26): "Not entered yet" boxes show only during clinic hours to 11:59 PM, never 12:00 AM to 9:59 AM.
  const open = hm >= "10:00";
  const shown = g.branches.filter((b) => open || b.todayCell.kind !== "empty");
  return (
    <>
      {/* CHRIS (Nov 25): today's sales logged so far is the top view for management. */}
      <div className="card">
        <div className="card-head">
          <h2>Today so far, {dayLabel(g.today)}</h2>
          <Link className="small" href="/sales/daily">Daily Sales →</Link>
        </div>
        <div className="glance-total"><strong>{php(g.todaySoFar)}</strong><span className="muted small">{open ? `${entered} of ${g.branches.length} branches entered` : "Clinics open at 10 AM"}</span></div>
        {shown.length > 0 && <div className="glance-branches">
          {shown.map((b) => (
            <div key={b.id} className={`glance-branch ${b.todayCell.kind === "empty" ? "missing" : ""}`}>
              <span className="small muted">{b.name}</span>
              <strong>{b.todayCell.kind === "empty" ? <span className="muted">Not entered yet</span> : <Cell c={b.todayCell} />}</strong>
            </div>
          ))}
        </div>}
      </div>


      {duty && (
        <div className="card">
          <div className="card-head">
            <h2>On duty today</h2>
            <Link className="small" href="/time">Time clock →</Link>
          </div>
          <OnDutyFaces rows={duty} faces={faces} branches={branches} nowHm={hm} />
        </div>
      )}

      {g.through && (
        <div className="card">
          <div className="card-head">
            <h2>Yesterday, {dayLabel(g.yesterday)}</h2>
            <Link className="small" href="/sales/daily">Daily Sales →</Link>
          </div>
          <div className="glance-total"><strong>{php(g.yesterdayTotal)}</strong><span className="muted small">all branches{g.yesterdayMissing.length > 0 && `, ${g.yesterdayMissing.length} not entered yet`}</span></div>
          <div className="glance-branches">
            {g.branches.map((b) => (
              <div key={b.id} className={`glance-branch ${b.yesterday.kind === "empty" ? "missing" : ""}`}>
                <span className="small muted">{b.name}</span>
                <strong><Cell c={b.yesterday} /></strong>
                {b.vsAvg !== null && <span className="small"><Delta v={b.vsAvg} /> vs its daily average</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h2>{monthLabel(ym)} so far</h2>
          <Link className="small" href="/">Sales dashboard →</Link>
        </div>
        {!g.through ? <p className="muted" style={{ margin: 0 }}>First day of the month. Figures start tomorrow.</p> : (
          <>
            <div className="grid glance-stats">
              <div className="stat">
                <span className="label">Month to date</span>
                <span className="value">{php(g.mtd)}</span>
                <span className="note"><Delta v={g.change} /> vs the same days of {monthLabel(g.lastSameMonth)} ({php(g.lastSame)})</span>
              </div>
              {g.pace !== null && (
                <div className="stat">
                  <span className="label">On pace for</span>
                  <span className="value">{php(g.pace)}</span>
                  <span className="note">{monthLabel(g.lastSameMonth)} ended at {php(g.lastMonthTotal)} <Delta v={g.lastMonthTotal ? (g.pace - g.lastMonthTotal) / g.lastMonthTotal : null} /></span>
                </div>
              )}
              {g.best && g.worst && (
                <div className="stat">
                  <span className="label">Branches vs last month</span>
                  <span className="note">Best: <strong>{g.best.name}</strong> <Delta v={g.best.change} /></span>
                  <span className="note">Needs attention: <strong>{g.worst.name}</strong> <Delta v={g.worst.change} /></span>
                </div>
              )}
            </div>
            <div className="table-wrap">
              <table className="glance-table">
                <thead><tr><th>Branch</th><th className="num">Month to date</th><th className="num">vs last month</th><th className="num">Daily average</th><th className="num">Empty days</th></tr></thead>
                <tbody>
                  {g.branches.map((b) => (
                    <tr key={b.id}>
                      <td>{b.name}</td>
                      <td className="num">{php(b.mtd)}</td>
                      <td className="num"><Delta v={b.change} title={`Same days last month: ${php(b.lastSame)}`} /></td>
                      <td className="num">{b.avg === null ? "–" : php(b.avg)}</td>
                      <td className="num">{b.emptyDays.length ? <Link href="/sales/daily">{b.emptyDays.length}</Link> : <span className="muted">0</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="small muted" style={{ marginBottom: 0 }}>Through {dayLabel(g.through)}. Zero sales days count as ₱0; Closed and empty days are left out of averages.</p>
          </>
        )}
      </div>
    </>
  );
}
