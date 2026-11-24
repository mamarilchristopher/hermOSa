import Link from "next/link";
import { centsToPhp } from "@/lib/csv";
import { monthLabel } from "@/lib/insights";
import { dayLabel, type DayCell, type Glance } from "@/lib/homeGlance";

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

/** Home for owners, finance and managers: what needs doing, yesterday per branch, and how the month is going. */
export function ManagerHome({ g, todos }: { g: Glance; todos: Todo[] }) {
  const ym = g.today.slice(0, 7);
  return (
    <>
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
          {g.todaySoFar > 0 && <p className="small muted" style={{ marginBottom: 0 }}>Today so far: {php(g.todaySoFar)} entered.</p>}
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
