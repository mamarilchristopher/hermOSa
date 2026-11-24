import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAccess } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { centsToPhp } from "@/lib/csv";
import { isIsoDate, manilaToday } from "@/lib/dates";
import { addDays, sortBranches, weekday, WEEKDAYS } from "@/lib/insights";
import { CorrectForm, DecideForm, EnterForm } from "./Forms";

type Status = {
  ok: boolean; error?: string; second_signoff: boolean;
  branches: { id: string; code: string; name: string; can_enter: boolean; self_publish: boolean; can_approve: boolean }[];
  days: [string, string, number | null, string | null, boolean, number | null][];
  corrections: { id: string; branch_id: string; date: string; old_cents: number; new_cents: number; reason: string; requested_by: string; mine: boolean }[];
};

const nice = (d: string) => `${WEEKDAYS[weekday(d)]}, ${new Date(`${d}T00:00:00Z`).toLocaleDateString("en-PH", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" })}`;
const short = (c: number) => (c >= 100_000_00 ? `${(c / 100_000_00).toFixed(c >= 1_000_000_00 ? 0 : 1)}M` : c >= 100_000 ? `${Math.round(c / 100_000)}k` : `${Math.round(c / 100)}`);

/** Daily sales: replaces the daily Google Sheet update. One screen for every branch the user looks after. */
export default async function DailySales({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const { supabase, access } = await requireAccess();
  if (!access.grants.some((g) => ["OWNER", "FINANCE", "MANAGER", "AUDITOR"].includes(g.role))) redirect("/me");
  const today = manilaToday();
  const sp = await searchParams;
  const date = isIsoDate(sp.date) && sp.date <= today ? sp.date : today;
  const weekStart = addDays(date, -6);
  const { data } = await supabase.rpc("daily_sales_status", { p_start: weekStart, p_end: date });
  const st = (data ?? { ok: false }) as Status;
  const branches = st.ok ? sortBranches(st.branches) : [];
  const cell = (b: string, d: string) => st.days?.find((x) => x[0] === b && x[1] === d);
  const week = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const anyEnter = branches.some((b) => b.can_enter);
  const dayTotal = branches.reduce((s, b) => s + Number(cell(b.id, date)?.[2] ?? 0), 0);
  const missingToday = branches.filter((b) => { const c = cell(b.id, date); return !c || (c[2] === null && !c[3] && !c[4]); }).length;

  return (
    <>
      <TopBar access={access} />
      <main>
        <h1>Daily sales</h1>
        <p className="muted small">Each branch&apos;s total for the day, in place of the Sales Source Tracker sheet. Amounts are declared sales (cash and online).</p>

        <div className="periods card">
          <div className="segmented">
            <Link href={`/sales/daily?date=${addDays(date, -1)}`}>← Previous day</Link>
            <Link href={`/sales/daily?date=${date}`} className="on">{date === today ? "Today" : nice(date)}</Link>
            {date < today && <Link href={`/sales/daily?date=${addDays(date, 1)}`}>Next day →</Link>}
          </div>
          <form>
            <input type="date" name="date" defaultValue={date} max={today} aria-label="Date" />
            <button type="submit" className="secondary">Go</button>
          </form>
          {anyEnter && <span><Link className="button secondary" href="/sales/upload">Upload tracker file</Link></span>}
        </div>

        {!st.ok && <div className="notice error">Daily sales isn&apos;t set up yet. The owner needs to run update-0013 in Supabase.</div>}
        {st.ok && (
          <>
            <p className="small"><strong>{nice(date)}</strong> · {centsToPhp(dayTotal)} recorded{missingToday > 0 && ` · ${missingToday} branch${missingToday > 1 ? "es" : ""} still to enter`}</p>
            <div className="grid branches">
              {branches.map((b) => {
                const c = cell(b.id, date);
                const recorded = c?.[2] ?? null, mark = c?.[3] ?? null, staged = c?.[4] ?? false, service = c?.[5] ?? null;
                const pendingFix = st.corrections.find((x) => x.branch_id === b.id && x.date === date);
                const diff = recorded !== null && service !== null ? Number(recorded) - Number(service) : null;
                return (
                  <div key={b.id} className="card day-card">
                    <div className="day-card-head"><h2>{b.name}</h2>
                      {recorded !== null ? <span className="pill PUBLISHED">Recorded</span> : mark ? <span className="pill PUBLISHED">{mark === "CLOSED" ? "Closed" : "No sales"}</span>
                        : staged ? <span className="pill STAGED">Waiting sign-off</span> : <span className="pill REVERSED">Not entered</span>}
                    </div>
                    {recorded !== null && <div className="value-lg">{centsToPhp(recorded)}</div>}
                    {staged && recorded === null && <p className="small muted">Entered, waiting for a second person on <Link href="/imports">Imports</Link>.</p>}
                    {recorded === null && !mark && !staged && b.can_enter && <EnterForm branch={b.id} date={date} />}
                    {recorded === null && !mark && !staged && !b.can_enter && <p className="small muted">Not entered yet.</p>}
                    <p className="small service-line">
                      Service log: {service !== null ? centsToPhp(service) : "no entries"}
                      {diff !== null && diff !== 0 && <span className="delta down"> {diff > 0 ? `${centsToPhp(diff)} more declared than logged` : `${centsToPhp(-diff)} more logged than declared`}</span>}
                      {diff === 0 && <span className="saved-tick"> ✓ matches</span>}
                    </p>
                    {pendingFix && <p className="small notice info">Correction to {centsToPhp(pendingFix.new_cents)} waiting for sign-off ({pendingFix.reason}).</p>}
                    {recorded !== null && !pendingFix && b.can_enter && <CorrectForm branch={b.id} date={date} current={centsToPhp(recorded)} />}
                  </div>
                );
              })}
            </div>

            {st.corrections.length > 0 && (
              <div className="card">
                <h2>Corrections waiting for sign-off</h2>
                <ul className="plain-list">
                  {st.corrections.map((x) => {
                    const b = branches.find((y) => y.id === x.branch_id);
                    return (
                      <li key={x.id}>
                        <span><strong>{b?.name}</strong>, {x.date}: {centsToPhp(x.old_cents)} → <strong>{centsToPhp(x.new_cents)}</strong>
                          <span className="small muted"> · {x.reason} · asked by {x.requested_by}</span></span>
                        {b?.can_approve && <DecideForm id={x.id} mine={x.mine} />}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            <h2>Last 7 days</h2>
            <div className="table-wrap">
              <table className="week">
                <thead><tr><th>Branch</th>{week.map((d) => <th key={d} className="num"><Link href={`/sales/daily?date=${d}`}>{WEEKDAYS[weekday(d)]} {Number(d.slice(8))}</Link></th>)}</tr></thead>
                <tbody>
                  {branches.map((b) => (
                    <tr key={b.id}>
                      <td>{b.name.replace(/ \(.*\)$/, "")}</td>
                      {week.map((d) => {
                        const c = cell(b.id, d);
                        const v = c?.[2] != null ? `₱${short(Number(c[2]))}` : c?.[3] ? (c[3] === "CLOSED" ? "Closed" : "₱0") : c?.[4] ? "Waiting" : "–";
                        const flag = c?.[2] != null && c?.[5] != null && Number(c[2]) !== Number(c[5]);
                        return <td key={d} className={`num ${v === "–" && d < today ? "gap" : ""} ${d === date ? "sel" : ""}`} title={flag ? "Differs from the service log" : undefined}>{v}{flag && " •"}</td>;
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="small muted">• = the declared total differs from the service log that day. A dash on a past day means nothing was entered.</p>
          </>
        )}
      </main>
    </>
  );
}
