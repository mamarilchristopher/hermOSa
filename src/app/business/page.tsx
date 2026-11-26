import Link from "next/link";
import { redirect } from "next/navigation";
import { can, requireAccess } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { MonthBars, WeekBars, WeekdayBars } from "@/components/SalesCharts";
import { manilaToday } from "@/lib/dates";
import { computeGlance, dayLabel, type StatusDay } from "@/lib/homeGlance";
import { addDays, addMonths, monthLabel, monthStart, sortBranches, WEEKDAYS } from "@/lib/insights";
import { peso, sessionsOf, shortName } from "@/lib/promoRules";
import { nextDue, type Log, type PromoPart } from "@/lib/promoTrack";
import type { PlanStep } from "@/lib/promoRules";
import {
  bookingPatterns, companyDays, dayContext, monthEndOf, monthlyTotals, promoPicks, serviceMix, staffPatterns, weekdayAverages, weeklyTotals,
  type Booking, type LogLite,
} from "@/lib/business";
import { loadIdeas } from "../promos/ideas";

type Supa = Awaited<ReturnType<typeof requireAccess>>["supabase"];
type DailyStatus = { ok: boolean; branches?: { id: string; code: string; name: string }[]; days?: StatusDay[] };
type PromoRow = { id: string; title: string; state: string; parts: PromoPart[] | null };
type PClient = { id: string; promo_id: string; client_name: string; contact: string | null; branch_id: string; state: string; schedule: PlanStep[] | null };

/** Every row of a query, 1000 at a time (Supabase returns at most 1000 per call). */
async function every<T>(q: (from: number, to: number) => PromiseLike<{ data: T[] | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let a = 0; a < 30000; a += 1000) {
    const { data } = await q(a, a + 999);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}
async function chunks<T>(ids: string[], f: (part: string[]) => PromiseLike<{ data: T[] | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 150) out.push(...((await f(ids.slice(i, i + 150))).data ?? []));
  return out;
}

const Delta = ({ c }: { c: number | null }) =>
  c === null || !Number.isFinite(c) ? <span className="muted">–</span> : <span className={`delta ${c >= 0 ? "up" : "down"}`}>{c >= 0 ? "+" : ""}{Math.round(c * 100)}%</span>;
const change = (cur: number, base: number) => (base > 0 ? (cur - base) / base : null);
const KIND: Record<string, string> = { SEASON: "Season", SLOW: "Slow seller", PROGRAM: "Year program" };

async function promoDue(supabase: Supa, today: string) {
  const [{ data: pData, error }, { data: cData }] = await Promise.all([
    supabase.from("promos").select("id, title, state, parts").eq("state", "APPROVED"),
    supabase.from("promo_clients").select("id, promo_id, client_name, contact, branch_id, state, schedule").eq("state", "ACTIVE"),
  ]);
  if (error) return null;
  const promos = (pData ?? []) as PromoRow[];
  const clients = (cData ?? []) as PClient[];
  const logs = await chunks<{ promo_client_id: string; service_id: string; service_date: string; session_no: number; amount_paid_cents: number }>(
    clients.map((c) => c.id),
    (ids) => supabase.from("service_logs").select("promo_client_id, service_id, service_date, session_no, amount_paid_cents").in("promo_client_id", ids).neq("state", "REJECTED"),
  );
  const names: Record<string, string> = {};
  for (const p of promos) for (const x of p.parts ?? []) names[x.service_id] = shortName(x.name);
  const title = Object.fromEntries(promos.map((p) => [p.id, p.title]));
  const due = clients.flatMap((c) => {
    const ls: Log[] = logs.filter((l) => l.promo_client_id === c.id).map((l) => ({ service_id: l.service_id, date: l.service_date, n: l.session_no, amount_cents: Number(l.amount_paid_cents) }));
    const next = nextDue(c.schedule ?? [], ls, today);
    return next && next.late >= 0 ? [{ c, next, promo: title[c.promo_id] ?? "Promo" }] : [];
  }).sort((a, b) => b.next.late - a.next.late);
  const active = (id: string) => clients.filter((c) => c.promo_id === id).length;
  return { promos: promos.map((p) => ({ id: p.id, title: p.title, active: active(p.id) })), due, names };
}

/** Business dashboard (CHRIS Nov 27): sales and trends, employee patterns and today's promo picks, for all management. */
export default async function Business() {
  const { supabase, access, branches } = await requireAccess();
  if (!access.grants.some((g) => ["OWNER", "FINANCE", "AUDITOR", "MANAGER"].includes(g.role))) redirect("/me");
  const ownerGm = can(access, ["OWNER"], null) || can(access, ["MANAGER"], null);
  const today = manilaToday();
  const from28 = addDays(today, -27), from56 = addDays(today, -55);

  const [{ data: st }, logs, { data: svcData }, { data: empData }, lines, { data: lateData }, bookings, ideas, promo] = await Promise.all([
    supabase.rpc("daily_sales_status", { p_start: monthStart(addMonths(monthStart(today), -13)), p_end: today }),
    every<LogLite>((a, b) => supabase.from("service_logs").select("id, branch_id, service_date, service_id, amount_paid_cents, performer_id, assistant_id, commission_type")
      .gte("service_date", from56).lte("service_date", today).neq("state", "REJECTED").order("id").range(a, b)),
    supabase.from("services").select("id, name"),
    supabase.from("employees").select("id, full_name, branch_id").eq("active", true),
    every<{ employee_id: string; amount_cents: number }>((a, b) => supabase.from("commission_lines").select("employee_id, amount_cents, service_logs!inner(service_date, state)")
      .gte("service_logs.service_date", from28).lte("service_logs.service_date", today).neq("service_logs.state", "REJECTED").order("id").range(a, b)),
    supabase.from("late_ntes").select("employee_id, late_minutes").gte("work_date", from28).lte("work_date", today).neq("state", "VOID"),
    every<Booking>((a, b) => supabase.from("bookings").select("csr_employee_id, booked_on, appointment_date, status, branch_id")
      .or(`booked_on.gte.${from28},appointment_date.gte.${from28}`).lte("appointment_date", addDays(today, 90)).order("id").range(a, b)),
    loadIdeas(supabase, today),
    promoDue(supabase, today),
  ]);

  const s = (st ?? { ok: false }) as DailyStatus;
  if (!s.ok) {
    return (<><TopBar access={access} /><main><h1>Business</h1><div className="notice error">Sales figures couldn&apos;t load. Try again in a moment.</div></main></>);
  }
  const sb = sortBranches(s.branches ?? []);
  const days = s.days ?? [];
  const g = computeGlance(today, sb, days);
  const byDay = companyDays(days, sb.map((b) => b.id));
  const weeks = weeklyTotals(byDay, today, 12);
  const months = monthlyTotals(byDay, today, 13);
  const wk = weekdayAverages(byDay, today, 12);
  const ctx = dayContext(today, wk, { mtd: g.mtd, lastMonthTotal: g.lastMonthTotal, worst: g.worst, monthEnd: monthEndOf(today) });
  const picks = promoPicks(ideas.ideas, ctx, 3);
  const withAvg = wk.filter((w) => w.avg !== null) as { day: number; avg: number }[];
  const bestDay = withAvg.length ? withAvg.reduce((a, b) => (b.avg > a.avg ? b : a)) : null;
  const slowDay = withAvg.length ? withAvg.reduce((a, b) => (b.avg < a.avg ? b : a)) : null;
  const lastWeekSame = byDay.get(addDays(today, -7)) ?? null;
  const yesterdayLastWeek = byDay.get(addDays(today, -8)) ?? null;

  const names = Object.fromEntries(((svcData ?? []) as { id: string; name: string }[]).map((x) => [x.id, x.name]));
  const mix = serviceMix(logs, names, today);
  const firstLog = logs.reduce<string | null>((m, l) => (m === null || l.service_date < m ? l.service_date : m), null);
  const mixHasPrev = firstLog !== null && firstLog <= addDays(from28, -7);
  const bName = Object.fromEntries(branches.map((b) => [b.id, b.name]));
  const people = ((empData ?? []) as { id: string; full_name: string; branch_id: string | null }[]).map((e) => ({ id: e.id, name: e.full_name, branch: e.branch_id ? bName[e.branch_id] ?? "" : "" }));
  const staff = staffPatterns(logs, lines, (lateData ?? []) as { employee_id: string; late_minutes: number }[], people, from28);
  const empName = Object.fromEntries(people.map((p) => [p.id, p.name]));
  const bk = bookingPatterns(bookings, empName, from28, today);
  const topSeller = staff.find((x) => x.sales > 0);
  const topAssist = [...staff].sort((a, b) => b.assist - a.assist)[0];
  const mostLate = [...staff].sort((a, b) => b.lateMin - a.lateMin)[0];
  const lateTotal = staff.reduce((n, x) => n + x.lates, 0);

  const gap = g.lastMonthTotal - g.mtd;
  const tips: string[] = [];
  if (ctx.payday) tips.push("Payday: clients have cash today. Lead with prepaid programs and bigger bundles.");
  if (ctx.weak && ctx.weekdayAvg !== null && ctx.overallAvg !== null) tips.push(`${ctx.weekdayName} is usually slower (about ${peso(ctx.weekdayAvg)} vs ${peso(ctx.overallAvg)} on an average day). An easy-yes bundle helps fill chairs.`);
  if (ctx.strong && ctx.weekdayAvg !== null) tips.push(`${ctx.weekdayName} is usually one of the busiest days (about ${peso(ctx.weekdayAvg)}). Make sure every branch is fully staffed.`);
  if (ctx.needPerDay !== null) tips.push(`To beat last month, the company needs about ${peso(ctx.needPerDay)} a day for the ${ctx.daysLeft} day${ctx.daysLeft === 1 ? "" : "s"} left.`);
  if (ctx.behind) tips.push(`${ctx.behind.name} is ${Math.round(-ctx.behind.change * 100)}% behind the same days last month. Post today's pick on its page and ask the CSRs to follow up its leads first.`);
  if (promo?.due.length) tips.push(`${promo.due.length} promo client${promo.due.length === 1 ? " is" : "s are"} due for a session or late. Message them to book (list below).`);

  return (
    <>
      <TopBar access={access} />
      <main className="business">
        <h1>Business</h1>
        <p className="muted small">{dayLabel(today)} · the same sales figures as Home and Daily Sales (all branches). Services, staff and bookings are from the last 28 days.</p>

        <div className="grid">
          <div className="card stat hero">
            <div className="label">Today so far</div>
            <div className="value">{peso(g.todaySoFar)}</div>
            <div className="note">Last {WEEKDAYS[new Date(`${today}T00:00:00Z`).getUTCDay()]}: {lastWeekSame === null ? "–" : peso(lastWeekSame)} · fills in as sales are typed</div>
          </div>
          <div className="card stat">
            <div className="label">Yesterday</div>
            <div className="value">{peso(g.yesterdayTotal)}</div>
            <div className="note">Same day last week: {yesterdayLastWeek === null ? "–" : peso(yesterdayLastWeek)} {yesterdayLastWeek !== null && g.yesterdayMissing.length === 0 && <Delta c={change(g.yesterdayTotal, yesterdayLastWeek)} />}</div>
            {g.yesterdayMissing.length > 0 && <div className="note" style={{ color: "var(--warn)" }}>Not typed yet: {g.yesterdayMissing.join(", ")}</div>}
          </div>
          <div className="card stat">
            <div className="label">{monthLabel(today.slice(0, 7))} so far</div>
            <div className="value">{peso(g.mtd)} <Delta c={g.change} /></div>
            <div className="note">vs {peso(g.lastSame)} on the same days last month{g.pace ? ` · on pace for ${peso(g.pace)}` : ""}</div>
          </div>
          <div className="card stat">
            <div className="label">To beat last month</div>
            <div className="value">{gap > 0 ? `${peso(ctx.needPerDay ?? 0)}/day` : "Ahead"}</div>
            <div className="note">{gap > 0 ? `${peso(gap)} more in ${ctx.daysLeft} day${ctx.daysLeft === 1 ? "" : "s"} to pass ${peso(g.lastMonthTotal)}` : `Already past last month's ${peso(g.lastMonthTotal)}`}</div>
          </div>
        </div>

        <div className="card biz-today">
          <h2 style={{ marginTop: 0 }}>Today&apos;s promo picks</h2>
          {tips.length > 0 && <ul className="biz-tips">{tips.map((t) => <li key={t}>{t}</li>)}</ul>}
          {ideas.missing && <p className="small muted">Promo ideas start once update-0086 is run in Supabase.</p>}
          {!ideas.missing && picks.length === 0 && <p className="small muted">No promo ideas yet: the Service log needs a few more weeks of history.</p>}
          <div className="promo-ideas">
            {picks.map(({ idea, today: why }) => (
              <div key={idea.id} className="promo-idea">
                <span className="tag">{KIND[idea.kind]}</span>
                <strong>{idea.title}</strong>
                <span className="small">{idea.items.length === 1 ? `${shortName(idea.items[0].name)} ${idea.items[0].paid}+${idea.items[0].free}` : idea.items.map((i) => `${i.paid} ${shortName(i.name)}`).join(", ")}</span>
                <span className="small"><strong>{peso(idea.price)}</strong> · {sessionsOf(idea.items)} sessions</span>
                <span className="small"><strong>Why today:</strong> {why}</span>
                {ownerGm && <Link className="button secondary small" href={`/promos?idea=${encodeURIComponent(idea.id)}`}>Open in builder</Link>}
              </div>
            ))}
          </div>
          {promo && promo.promos.length > 0 && (
            <>
              <h3 className="small" style={{ marginBottom: 4 }}>Running promos</h3>
              <p className="small" style={{ marginTop: 0 }}>
                {promo.promos.map((p, i) => (
                  <span key={p.id}>{i > 0 && " · "}{ownerGm ? <Link href={`/promos/${p.id}`}>{p.title}</Link> : p.title} ({p.active} active)</span>
                ))}
              </p>
            </>
          )}
          {promo && promo.due.length > 0 && (
            <>
              <h3 className="small" style={{ marginBottom: 4 }}>Promo clients to message today</h3>
              <ul className="promo-follow">
                {promo.due.slice(0, 10).map(({ c, next, promo: t }) => (
                  <li key={c.id}>
                    <Link href={`/promos/client/${c.id}`}>{c.client_name}</Link> · {t}: {promo.names[next.s] ?? "session"} session {next.n}
                    {" · "}{next.late > 0 ? <span className="delta down">{next.late} day{next.late === 1 ? "" : "s"} late</span> : "due today"}
                    {bName[c.branch_id] ? <span className="muted"> · {bName[c.branch_id]}</span> : ""}
                  </li>
                ))}
              </ul>
              {promo.due.length > 10 && <p className="small muted">And {promo.due.length - 10} more on each promo&apos;s page.</p>}
            </>
          )}
        </div>

        <div className="card">
          <h2 style={{ marginTop: 0 }}>Branches this month</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Branch</th><th className="num">So far</th><th className="num">vs last month</th><th className="num">Per day</th><th className="num">Yesterday</th></tr></thead>
              <tbody>
                {g.branches.map((b) => (
                  <tr key={b.id}>
                    <td><Link href={`/?p=month&branch=${sb.find((x) => x.id === b.id)?.code ?? ""}`}>{b.name}</Link></td>
                    <td className="num">{peso(b.mtd)}</td>
                    <td className="num"><Delta c={b.change} /></td>
                    <td className="num">{b.avg === null ? "–" : peso(b.avg)}</td>
                    <td className="num">{b.yesterday.kind === "sales" ? peso(b.yesterday.cents) : b.yesterday.kind === "zero" ? "₱0" : b.yesterday.kind === "closed" ? "Closed" : <span className="muted">not typed</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <h2 style={{ marginTop: 0 }}>Trends</h2>
          <h3 className="small">Weekly sales, last 12 weeks (Monday to Sunday)</h3>
          <WeekBars weeks={weeks} title="Weekly sales, last 12 weeks" />
          {weeks.length >= 3 && (
            <p className="small muted">Last full week {peso(weeks[weeks.length - 2].cents)} <Delta c={change(weeks[weeks.length - 2].cents, weeks[weeks.length - 3].cents)} /> vs the week before.</p>
          )}
          <h3 className="small">Monthly sales, last 13 months</h3>
          <MonthBars months={months} title="Monthly sales, last 13 months" />
          <h3 className="small">Average day, by weekday (last 12 weeks)</h3>
          <WeekdayBars days={wk} />
          {bestDay && slowDay && bestDay.day !== slowDay.day && (
            <p className="small muted">Busiest: {WEEKDAYS[bestDay.day]} ({peso(bestDay.avg)}). Slowest: {WEEKDAYS[slowDay.day]} ({peso(slowDay.avg)}): a good day for promos and staff day-offs.</p>
          )}
        </div>

        <div className="card">
          <h2 style={{ marginTop: 0 }}>What clients are buying</h2>
          <p className="small muted">From the Service log, last 28 days{mixHasPrev ? ", against the 28 days before" : ""}. Packages and single sessions of the same treatment are counted together.</p>
          {mix.list.length === 0 && <p className="small muted">No Service log entries yet.</p>}
          {mix.total > 0 && <p className="small"><strong>Hiko</strong> is {Math.round((mix.hiko / mix.total) * 100)}% of service sales ({peso(mix.hiko)} of {peso(mix.total)}).</p>}
          {mix.list.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Treatment</th><th className="num">Sales</th><th className="num">Visits</th>{mixHasPrev && <th className="num">Change</th>}</tr></thead>
                <tbody>
                  {mix.list.filter((x) => x.n > 0).slice(0, 12).map((x) => (
                    <tr key={x.name}>
                      <td>{x.name}</td>
                      <td className="num">{peso(x.cents)}</td>
                      <td className="num">{x.n}</td>
                      {mixHasPrev && <td className="num"><Delta c={x.prevCents > 0 ? change(x.cents, x.prevCents) : null} /></td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {mixHasPrev && mix.list.some((x) => x.n === 0 && x.prevN > 0) && (
            <p className="small muted">Sold before but not in the last 28 days: {mix.list.filter((x) => x.n === 0 && x.prevN > 0).map((x) => x.name).join(", ")}.</p>
          )}
        </div>

        <div className="card">
          <h2 style={{ marginTop: 0 }}>Team patterns</h2>
          <p className="small muted">Last 28 days. Sales led = amount paid on services they performed. Commission is approved and waiting lines.</p>
          {staff.length > 0 && (
            <ul className="biz-tips">
              {topSeller && <li>Top in sales: <strong>{topSeller.name}</strong> ({peso(topSeller.sales)} from {topSeller.lead} service{topSeller.lead === 1 ? "" : "s"}).</li>}
              {topAssist && topAssist.assist > 0 && <li>Most assists: <strong>{topAssist.name}</strong> ({topAssist.assist}).</li>}
              {mostLate && mostLate.lateMin > 0 && <li>Most late minutes: <strong>{mostLate.name}</strong> ({mostLate.lates} late{mostLate.lates === 1 ? "" : "s"}, {mostLate.lateMin} min). {lateTotal} late{lateTotal === 1 ? "" : "s"} across the team.</li>}
            </ul>
          )}
          {staff.length === 0 && <p className="small muted">No services or lates logged in the last 28 days.</p>}
          {staff.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Name</th><th>Branch</th><th className="num">Led</th><th className="num">Assisted</th><th className="num">Sales led</th><th className="num">Commission</th><th className="num">Lates</th></tr></thead>
                <tbody>
                  {staff.map((x) => (
                    <tr key={x.id}>
                      <td>{x.name}</td>
                      <td>{x.branch}</td>
                      <td className="num">{x.lead}</td>
                      <td className="num">{x.assist}</td>
                      <td className="num">{peso(x.sales)}</td>
                      <td className="num">{peso(x.commission)}</td>
                      <td className="num">{x.lates ? `${x.lates} (${x.lateMin} min)` : "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <h3 className="small">Bookings</h3>
          {bk.past === 0 && bk.csrs.length === 0 ? <p className="small muted">No bookings in the last 28 days.</p> : (
            <>
              <p className="small">
                {bk.past} appointment{bk.past === 1 ? "" : "s"} in the last 28 days
                {bk.showRate !== null ? `, ${Math.round(bk.showRate * 100)}% showed up` : ""}
                {bk.unresponsive ? `, ${bk.unresponsive} unresponsive` : ""}
                {bk.busiest ? `. Most booked day: ${bk.busiest}` : ""}.
                {bk.unresponsive > 0 && <> <Link href="/bookings/followups">Follow-ups</Link></>}
              </p>
              {bk.csrs.length > 0 && (
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>Booked by</th><th className="num">Booked</th><th className="num">Appointments</th><th className="num">Showed up</th></tr></thead>
                    <tbody>
                      {bk.csrs.map((x) => (
                        <tr key={x.name}>
                          <td>{x.name}</td>
                          <td className="num">{x.made}</td>
                          <td className="num">{x.past}</td>
                          <td className="num">{x.past ? `${Math.round((x.showed / x.past) * 100)}%` : "–"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </main>
    </>
  );
}
