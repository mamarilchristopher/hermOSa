import Link from "next/link";
import { centsToPhp } from "@/lib/csv";
import type { BranchCheck, DayCheck } from "@/lib/declaredCheck";

const STATUS_TEXT: Record<DayCheck["status"], string> = { match: "Matches", short: "Short", over: "Over", closed: "Closed", undeclared: "Nothing declared" };

export function diffText(d: DayCheck): string {
  if (d.status === "match") return "✓ matches declared";
  if (d.status === "closed") return "Closed";
  if (d.status === "undeclared") return "nothing declared";
  return d.diff < 0 ? `${centsToPhp(-d.diff)} short of declared ${centsToPhp(d.declared ?? 0)}` : `${centsToPhp(d.diff)} over declared ${centsToPhp(d.declared ?? 0)}`;
}

/** CHRIS Nov 26: running check of the Nov 1–24 service log totals against the declared sales in Daily sales. */
export function DeclaredCheck({ checks, names, current, open, day, link }: {
  checks: (BranchCheck & { code: string })[]; names: Record<string, string>; current: string; open: boolean; day: string; link: (d: string, code: string) => string;
}) {
  const totalDeclared = checks.reduce((s, c) => s + c.declared, 0);
  const totalLogged = checks.reduce((s, c) => s + c.logged, 0);
  const pct = totalDeclared > 0 ? Math.min(100, Math.round((totalLogged / totalDeclared) * 100)) : 0;
  const mine = checks.find((c) => c.branch === current);
  return (
    <details className="card declared-check" open={open}>
      <summary>
        <strong>Nov 1–24 check: service log vs declared sales</strong>
        <span className="small muted"> {centsToPhp(totalLogged)} logged of {centsToPhp(totalDeclared)} declared ({pct}%)</span>
      </summary>
      <p className="small muted">A running check while the old paper logs are typed in. Declared = the totals in Daily sales. Logged = entries in this Service log (rejected ones don&apos;t count). Only Nov 1 to 24 is checked.</p>
      <div className="check-bar" aria-hidden><span style={{ width: `${pct}%` }} /></div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Branch</th><th className="num">Declared</th><th className="num">Logged</th><th className="num">Difference</th><th className="num">Days matching</th></tr></thead>
          <tbody>
            {checks.map((c) => (
              <tr key={c.branch} className={c.branch === current ? "on" : undefined}>
                <td><Link href={link(day, c.code)}>{names[c.branch]}</Link></td>
                <td className="num">{centsToPhp(c.declared)}</td>
                <td className="num">{centsToPhp(c.logged)}</td>
                <td className={`num ${c.diff === 0 ? "check-ok" : "check-off"}`}>{c.diff === 0 ? "✓" : `${c.diff < 0 ? "−" : "+"}${centsToPhp(Math.abs(c.diff))}`}</td>
                <td className="num">{c.matched} of {c.days.length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {mine && mine.days.length > 0 && (
        <>
          <h3 className="check-sub">{names[current]}, day by day</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Day</th><th className="num">Declared</th><th className="num">Logged</th><th className="num">Difference</th><th>Status</th></tr></thead>
              <tbody>
                {mine.days.map((d) => (
                  <tr key={d.date}>
                    <td><Link href={link(d.date, mine.code)}>{new Date(`${d.date}T00:00:00Z`).toLocaleDateString("en-PH", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })}</Link></td>
                    <td className="num">{d.declared === null ? (d.mark === "CLOSED" ? "Closed" : "–") : centsToPhp(d.declared)}</td>
                    <td className="num">{centsToPhp(d.logged)}</td>
                    <td className={`num ${d.status === "match" || d.status === "closed" ? "check-ok" : "check-off"}`}>{d.status === "match" || d.status === "closed" ? "✓" : `${d.diff < 0 ? "−" : "+"}${centsToPhp(Math.abs(d.diff))}`}</td>
                    <td><span className={`check-pill ${d.status}`}>{STATUS_TEXT[d.status]}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </details>
  );
}
