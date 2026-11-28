import Link from "next/link";
import type { ReactNode } from "react";
import { centsToPhp } from "@/lib/csv";
import { addDays, monthLabel } from "@/lib/insights";
import { dayLabel, type DayCell, type DayView, type Glance } from "@/lib/homeGlance";
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
    // v0.101.2: from Nov 25 the figure is the approved entries; a different typed Daily Sales figure is shown, not counted.
    case "sales": return <>{php(c.cents)}{c.log && <span className="muted small glance-log"> Sales Logged</span>}
      {c.typed !== undefined && <span className="glance-typed small" title={`Typed in Daily Sales: ${php(c.typed)}. The approved entries' total is used.`}>typed {php(c.typed)}</span>}</>;
    case "zero": return <span className="muted">Zero sales</span>;
    case "closed": return <span className="muted">Closed</span>;
    case "waiting": return <span className="pill STAGED">Waiting sign-off</span>;
    default: return <span className="pill REVERSED">Not entered</span>;
  }
}

/** How a finished day went, as one short chip (CHRIS Nov 28: dashboards, not sentences). */
function verdict(v: DayView): { text: string; tone: string } | null {
  if (v.vsAvg === null) return null;
  return v.vsAvg >= 0.1 ? { text: "Strong day", tone: "up" } : v.vsAvg <= -0.1 ? { text: "Slow day", tone: "down" } : { text: "Average day", tone: "neu" };
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
export function ManagerHome({ g, view, duty, faces = {}, branches, me, bookings, tardiness }: { me?: string; bookings?: ReactNode; tardiness?: ReactNode; g: Glance; view: DayView; duty: DutyRow[] | null; faces?: Record<string, DutyFace>; branches: { id: string; name: string; code?: string }[] }) {
  const ym = g.today.slice(0, 7);
  const hm = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Manila" });
  // CHRIS (Nov 26): "Not entered yet" boxes show only during clinic hours to 11:59 PM, never 12:00 AM to 9:59 AM.
  const open = hm >= "10:00";
  const shown = view.branches.filter((b) => !view.isToday || open || b.cell.kind !== "empty" || b.pending > 0);
  return (
    <>
      {/* CHRIS (Nov 25): today's sales logged so far is the top view for management.
          CHRIS (Nov 28): ‹ › switch the day; a finished day says how it went. */}
      <div className="card glance-today">
        <div className="card-head glance-head">
          <h2>{view.isToday ? "Today so far" : view.date === addDays(view.today, -1) ? "Yesterday" : "Sales"}, {dayLabel(view.date)}</h2>
          <div className="glance-nav">
            {view.prev ? <Link className="button secondary small" href={`/me?day=${view.prev}`} scroll={false} aria-label="Previous day">‹</Link>
              : <span className="button secondary small is-off" aria-hidden>‹</span>}
            {view.next ? <Link className="button secondary small" href={view.next === view.today ? "/me" : `/me?day=${view.next}`} scroll={false} aria-label="Next day">›</Link>
              : <span className="button secondary small is-off" aria-hidden>›</span>}
            {!view.isToday && <Link className="button secondary small" href="/me" scroll={false}>Today</Link>}
            <Link className="small" href={`/sales/daily?month=${view.date.slice(0, 7)}`}>Daily Sales →</Link>
          </div>
        </div>
        <div className="glance-total"><strong>{php(view.total)}</strong>
          {view.isToday
            ? <span className="muted small">{open ? `${view.withSales} of ${view.branches.length} branches with sales so far` : "Clinics open at 10 AM"}</span>
            : <span className="glance-verdict">{verdict(view) && <span className={`chg ${verdict(view)!.tone}`}>{verdict(view)!.text}</span>}
                <Delta v={view.vsAvg} title="vs this month's daily average" />{view.vsAvg !== null && <span className="muted small">vs month avg</span>}
                {view.branches.filter((b) => b.cell.kind === "empty").length > 0 && <span className="chg warn">{view.branches.filter((b) => b.cell.kind === "empty").length} not entered</span>}</span>}
        </div>
        {view.pending > 0 && <p className="small muted glance-pending"><span className="chg warn">+{php(view.pending)} waiting sign-off</span></p>}
        {shown.length > 0 && <div className="glance-branches">
          {shown.map((b) => {
            const inner = (<>
              <span className="small muted">{b.name}</span>
              <strong>{b.cell.kind === "empty" ? <span className="muted">{b.pending > 0 ? "Waiting for sign-off" : view.isToday ? "Nothing logged yet" : "Not entered"}</span> : <Cell c={b.cell} />}</strong>
              {!view.isToday && <Delta v={b.vsAvg} title="vs this branch's daily average this month" />}
              {b.pending > 0 && <span className="small muted">+{php(b.pending)} waiting sign-off</span>}
            </>);
            // CHRIS Nov 26: a branch with sales opens that branch's Service log for the day.
            const code = branches.find((x) => x.id === b.id)?.code;
            return (b.cell.kind !== "empty" || b.pending > 0) && code
              ? <Link key={b.id} href={`/services?date=${view.date}&branch=${code}`} className="glance-branch glance-link">{inner}</Link>
              : <div key={b.id} className={`glance-branch ${b.cell.kind === "empty" && !b.pending ? "missing" : ""}`}>{inner}</div>;
          })}
        </div>}
      </div>

      {/* CHRIS Nov 26: Today so far > live Bookings > On duty today > Yesterday > month so far > Tardiness tracker. */}
      {bookings}

      {duty && (
        <div className="card">
          <div className="card-head">
            <h2>On duty today</h2>
            <Link className="small" href="/time">Time clock →</Link>
          </div>
          <OnDutyFaces rows={duty} faces={faces} branches={branches} nowHm={hm} me={me} />
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

      {tardiness}
    </>
  );
}
