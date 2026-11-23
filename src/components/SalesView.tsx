import Link from "next/link";
import { MonthBars, Spark, WeekdayBars } from "./SalesCharts";
import { centsToPhp } from "@/lib/csv";
import { addDays, change, WEEKDAYS, weekday, type DayRow, type Insights, type Scope, type ZeroMark } from "@/lib/insights";

function Delta({ cur, base, label }: { cur: number; base: number | null; label: string }) {
  const c = change(cur, base);
  if (c === null) return <span className="muted">no data for {label}</span>;
  const pct = `${c >= 0 ? "▲" : "▼"} ${Math.abs(c * 100).toFixed(1)}%`;
  return (
    <span>
      <span className={`delta ${c >= 0 ? "up" : "down"}`}>{pct}</span> <span className="muted">vs {label}</span>
    </span>
  );
}

function MissingLink({ s, branch, q }: { s: Scope; branch?: string; q: string }) {
  if (s.missing.length === 0) return <span className="missing-link none">✓ No missing days</span>;
  return (
    <Link className="missing-link" href={`/sales/missing?${q}${branch && !q.includes("branch=") ? `&branch=${branch}` : ""}`}>
      ⚠ {s.missing.length} day{s.missing.length > 1 ? "s" : ""} with no recorded sales
    </Link>
  );
}

export function SalesView({ ins, whole, q }: { ins: Insights; whole: boolean; q: string }) {
  const c = ins.company;
  const period = ins.period;
  return (
          <>
        <div className="grid">
          <div className="card stat hero">
            <div className="label">{whole ? "Company sales" : "Sales"}, {period.label}</div>
            <div className="value">{centsToPhp(c.total)}</div>
            <div className="note"><Delta cur={c.total} base={c.prev} label={ins.prevLabel} /></div>
            {!ins.prevLabel.includes("last year") && <div className="note"><Delta cur={c.total} base={c.lastYear} label="same period last year" /></div>}
            <div className="note" style={{ marginTop: 6 }}><MissingLink s={c} q={q} branch={whole ? undefined : ins.branches[0]?.branch.code} />{whole && c.missing.length > 0 ? <span className="muted"> (all branches)</span> : null}</div>
            {c.pendingMarks > 0 && (
              <div className="note"><Link href={`/sales/missing?${q}`}>{c.pendingMarks} Closed / No sales day{c.pendingMarks > 1 ? "s" : ""} waiting for a second person</Link></div>
            )}
          </div>
          <div className="card stat">
            <div className="label">Average per sales day</div>
            <div className="value">{c.avgPerDay === null ? "–" : centsToPhp(c.avgPerDay)}</div>
            <div className="note">{c.salesDays} days with recorded sales{c.closedDays ? `, ${c.closedDays} closed or no sales` : ""}</div>
            {c.best && <div className="note">Best day: {c.best.date} ({centsToPhp(c.best.cents)})</div>}
          </div>
          <div className="card stat">
            <div className="label">Year to date {ins.compareEnd.slice(0, 4)}</div>
            <div className="value">{centsToPhp(c.ytd)}</div>
            <div className="note"><Delta cur={c.ytd} base={c.ytdLastYear} label={`${Number(ins.compareEnd.slice(0, 4)) - 1} same dates`} /></div>
            {c.ytdLastYear !== null && <div className="note">Last year to same date: {centsToPhp(c.ytdLastYear)}</div>}
          </div>
        </div>

        <div className="two">
          <div className="card">
            <h2 style={{ marginTop: 0 }}>Monthly sales, last 13 months</h2>
            <p className="small muted" style={{ marginTop: 0 }}>Hover a bar for the amount. Hatched = this month so far.</p>
            <MonthBars months={c.months} title="Monthly sales, last 13 months" />
            <details className="small"><summary>Show as table</summary>
              <div className="table-wrap"><table><tbody>
                {c.months.map((m) => <tr key={m.ym}><td>{m.ym}{m.partial ? " (so far)" : ""}</td><td className="num">{centsToPhp(m.cents)}</td></tr>)}
              </tbody></table></div>
            </details>
          </div>
          <div className="card">
            <h2 style={{ marginTop: 0 }}>Average by weekday</h2>
            <p className="small muted" style={{ marginTop: 0 }}>Last 12 months, days with recorded sales</p>
            <WeekdayBars days={ins.weekdays} />
          </div>
        </div>

        {whole && (
          <>
            <h2>By Branch:</h2>
            <div className="grid branches">
              {ins.branches.map((b) => (
                <div className="card branch-card" key={b.branch.id}>
                  <div className="top">
                    <h3><Link className="card-link" href={`/?${q}&branch=${b.branch.code}`}>{b.branch.name} ›</Link></h3>
                    <Spark months={b.months} label={b.branch.name} />
                  </div>
                  {!b.branch.first_date ? (
                    <p className="muted small">No validated data yet.</p>
                  ) : (
                    <>
                      <div className="stat"><div className="value">{centsToPhp(b.total)}</div></div>
                      <div className="small"><Delta cur={b.total} base={b.prev} label={ins.prevLabel} /></div>
                      {!ins.prevLabel.includes("last year") && <div className="small"><Delta cur={b.total} base={b.lastYear} label="last year" /></div>}
                      <dl className="kv">
                        <dt>Share of company</dt><dd>{b.share === null ? "–" : `${(b.share * 100).toFixed(1)}%`}</dd>
                        <dt>Avg per sales day</dt><dd>{b.avgPerDay === null ? "–" : centsToPhp(b.avgPerDay)}</dd>
                        <dt>YTD</dt><dd>{centsToPhp(b.ytd)}</dd>
                        <dt>YTD vs last year</dt><dd>{(() => { const x = change(b.ytd, b.ytdLastYear); return x === null ? "–" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`; })()}</dd>
                      </dl>
                      <div style={{ marginTop: 8 }}><MissingLink s={b} branch={b.branch.code} q={q} /></div>
                    </>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </>
  );
}

/** Day-by-day list for one branch in the period, newest first. */
export function BranchDays({ ins, days, marks }: { ins: Insights; days: DayRow[]; marks: ZeroMark[] }) {
  const b = ins.branches[0];
  if (!b?.branch.first_date || ins.compareEnd < ins.period.start) return null;
  const sales = new Map(days.filter((d) => d[0] === b.branch.id).map((d) => [d[1], Number(d[2])]));
  const mark = new Map(marks.filter((m) => m[0] === b.branch.id).map((m) => [m[1], m]));
  const rows: string[] = [];
  for (let d = ins.compareEnd; d >= ins.period.start && rows.length < 400; d = addDays(d, -1)) {
    if (d < b.branch.first_date) break;
    rows.push(d);
  }
  const avg = b.avgPerDay;
  return (
    <>
      <h2>Day by Day</h2>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Date</th><th>Day</th><th className="num">Sales</th><th className="num">vs average day</th></tr></thead>
          <tbody>
            {rows.map((d) => {
              const c = sales.get(d);
              const m = mark.get(d);
              const diff = c !== undefined && avg ? (c - avg) / avg : null;
              return (
                <tr key={d}>
                  <td>{d}</td>
                  <td>{WEEKDAYS[weekday(d)]}</td>
                  <td className="num">
                    {c !== undefined ? centsToPhp(c)
                      : m ? <span className="muted">{m[2] === "CLOSED" ? "Closed" : "No sales"}{m[3] === "PENDING" ? " (needs 2nd person)" : ""}</span>
                      : <Link href={`/sales/missing?p=custom&start=${d}&end=${d}&branch=${b.branch.code}`}>Missing, fill in</Link>}
                  </td>
                  <td className="num">{diff === null ? "" : <span className={`delta ${diff >= 0 ? "up" : "down"}`}>{diff >= 0 ? "+" : ""}{(diff * 100).toFixed(0)}%</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
