import { Playfair_Display } from "next/font/google";
import Link from "next/link";
import { redirect } from "next/navigation";
import { can, requireAccess } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { BarRows, Chg, compact, DayColumns, Donut, GoldArea, GoldBars, GoldSpark, HeatCalendar, Ring } from "@/components/BizCharts";
import { CountUp } from "@/components/CountUp";
import { PromoMockup } from "@/components/PromoMockup";
import { manilaToday } from "@/lib/dates";
import { withApprovedSales } from "@/lib/approvedSales";
import { computeGlance, dayLabel, type StatusDay } from "@/lib/homeGlance";
import { addDays, addMonths, monthLabel, monthStart, sortBranches, WEEKDAYS } from "@/lib/insights";
import { centsToPhp } from "@/lib/csv";
import { adName, peso, sessionsOf, shortName } from "@/lib/promoRules";
import {
  bookingPatterns, companyDays, dayContext, monthEndOf, monthlyTotals, promoPicks, serviceMix, staffPatterns, weekdayAverages, weeklyTotals, weekStart,
  type Booking, type LogLite,
} from "@/lib/business";
import { loadIdeas } from "../promos/ideas";
import { every, promoDue } from "./load";

type DailyStatus = { ok: boolean; branches?: { id: string; code: string; name: string }[]; days?: StatusDay[] };

const change = (cur: number, base: number) => (base > 0 ? (cur - base) / base : null);
const KIND: Record<string, string> = { SEASON: "Season", SLOW: "Slow seller", PROGRAM: "Year program" };

// The serif the promo photos use (same as Sales › Promos).
const serif = Playfair_Display({ subsets: ["latin"], weight: ["600", "700"], display: "swap" });

/** Business dashboard (CHRIS Nov 27): sales and trends, employee patterns and today's promo picks, for all management. */
export default async function Business() {
  const { supabase, access, branches } = await requireAccess();
  if (!access.grants.some((g) => ["OWNER", "FINANCE", "AUDITOR", "MANAGER"].includes(g.role))) redirect("/me");
  const ownerGm = can(access, ["OWNER"], null) || can(access, ["MANAGER"], null);
  const today = manilaToday();
  const from28 = addDays(today, -27), from56 = addDays(today, -55);

  const [{ data: st }, logs, { data: svcData }, { data: empData }, lines, { data: lateData }, bookings, ideas, promo] = await Promise.all([
    // 25 months (under the 800-day limit): 13 on the chart plus the same months a year earlier for the dashed line.
    supabase.rpc("daily_sales_status", { p_start: monthStart(addMonths(monthStart(today), -25)), p_end: today }),
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
  const days = await withApprovedSales(supabase, s.days ?? [], today);
  const g = computeGlance(today, sb, days);
  const byDay = companyDays(days, sb.map((b) => b.id));
  const weeks = weeklyTotals(byDay, today, 12);
  const months = monthlyTotals(byDay, today, 13);
  const yearAgo = monthlyTotals(byDay, addMonths(today, -12), 13).map((m) => (m.cents > 0 ? m.cents : null));
  const wk = weekdayAverages(byDay, today, 12);
  const ctx = dayContext(today, wk, { mtd: g.mtd, lastMonthTotal: g.lastMonthTotal, worst: g.worst, monthEnd: monthEndOf(today) });
  const picks = promoPicks(ideas.ideas, ctx, 3);
  const withAvg = wk.filter((w) => w.avg !== null) as { day: number; avg: number }[];
  const bestDay = withAvg.length ? withAvg.reduce((a, b) => (b.avg > a.avg ? b : a)) : null;
  const slowDay = withAvg.length > 1 ? withAvg.reduce((a, b) => (b.avg < a.avg ? b : a)) : null;
  const val = (d: string) => byDay.get(d) ?? null;
  const last14 = Array.from({ length: 14 }, (_, i) => val(addDays(today, i - 14)));
  const lastWeekSame = val(addDays(today, -7));
  const yesterdayLastWeek = val(addDays(today, -8));
  const allTypedToday = g.branches.every((b) => b.today !== null);
  const lastMonthName = monthLabel(addMonths(today, -1).slice(0, 7)).slice(0, 3);

  // Calendar: the last 12 weeks, Monday to Sunday.
  const calStart = addDays(weekStart(today), -77);
  const cal = Array.from({ length: 12 }, (_, w) => ({
    start: addDays(calStart, w * 7),
    days: Array.from({ length: 7 }, (_, k) => { const d = addDays(calStart, w * 7 + k); return { d, cents: val(d), future: d > today }; }),
  }));
  const calMax = Math.max(1, ...cal.flatMap((w) => w.days.filter((x) => !x.future && x.d < today).map((x) => x.cents ?? 0)));

  const names = Object.fromEntries(((svcData ?? []) as { id: string; name: string }[]).map((x) => [x.id, x.name]));
  const mix = serviceMix(logs, names, today);
  const firstLog = logs.reduce<string | null>((m, l) => (m === null || l.service_date < m ? l.service_date : m), null);
  const mixHasPrev = firstLog !== null && firstLog <= addDays(from28, -7);
  const bName = Object.fromEntries(branches.map((b) => [b.id, b.name]));
  const people = ((empData ?? []) as { id: string; full_name: string; branch_id: string | null }[]).map((e) => ({ id: e.id, name: e.full_name, branch: e.branch_id ? bName[e.branch_id] ?? "" : "" }));
  const staff = staffPatterns(logs, lines, (lateData ?? []) as { employee_id: string; late_minutes: number }[], people, from28);
  const empName = Object.fromEntries(people.map((p) => [p.id, p.name]));
  const bk = bookingPatterns(bookings, empName, from28, today);
  const gap = g.lastMonthTotal - g.mtd;

  // Signals: one glance each, no sentences.
  const signals: { text: string; tone?: "bad" | "good"; title: string }[] = [];
  if (ctx.payday) signals.push({ text: "💸 Payday", title: "Clients have cash today: lead with prepaid programs and bigger bundles." });
  if (ctx.needPerDay !== null) signals.push({ text: `🎯 ${compact(ctx.needPerDay)}/day to beat ${lastMonthName}`, title: `${centsToPhp(gap)} more in ${ctx.daysLeft} days to pass last month.` });
  else if (g.lastMonthTotal > 0) signals.push({ text: `✓ Ahead of ${lastMonthName}`, tone: "good", title: `Already past last month's ${centsToPhp(g.lastMonthTotal)}.` });
  if (ctx.behind) signals.push({ text: `▼ ${ctx.behind.name} ${Math.round(ctx.behind.change * 100)}%`, tone: "bad", title: `${ctx.behind.name} is behind the same days last month: post today's pick on its page and follow up its leads first.` });
  if (ctx.weak) signals.push({ text: `📉 ${ctx.weekdayName}s are slow`, title: "An easy-yes bundle helps fill chairs today." });
  if (ctx.strong) signals.push({ text: `🔥 ${ctx.weekdayName}s are busy`, title: "Make sure every branch is fully staffed." });
  if (bestDay && slowDay && bestDay.day !== slowDay.day) signals.push({ text: `📅 ${WEEKDAYS[bestDay.day]} best · ${WEEKDAYS[slowDay.day]} slowest`, title: "Average day over the last 12 weeks." });
  if (promo?.due.length) signals.push({ text: `💬 ${promo.due.length} promo client${promo.due.length === 1 ? "" : "s"} due`, title: "Message them to book (below)." });

  const topStaff = staff.filter((x) => x.sales > 0 || x.lates > 0).slice(0, 8);
  const initial = (n: string) => (n.trim().split(/\s+/)[0]?.[0] ?? "?").toUpperCase();
  const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const shortDay = (d: string) => `${MO[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;

  return (
    <>
      <TopBar access={access} />
      <main className="business">
        <div className="biz-head"><h1>Business</h1><span className="muted">{dayLabel(today)} · all branches</span></div>

        <div className="biz-kpis">
          <div className="card biz-kpi">
            <div className="label">Today</div>
            <div className="value"><CountUp cents={g.todaySoFar} /></div>
            <div className="sub">{allTypedToday && lastWeekSame ? <Chg c={change(g.todaySoFar, lastWeekSame)} suffix={`vs last ${WEEKDAYS[new Date(`${today}T00:00:00Z`).getUTCDay()]}`} /> : <span className="chg neu">so far</span>}</div>
            <GoldSpark values={last14} id="sp-today" label="Daily sales, last 14 days" />
          </div>
          <div className="card biz-kpi">
            <div className="label">Yesterday</div>
            <div className="value"><CountUp cents={g.yesterdayTotal} /></div>
            <div className="sub">
              {g.yesterdayMissing.length > 0 ? <span className="chg warn" title={`Not typed yet: ${g.yesterdayMissing.join(", ")}`}>⚠ {g.yesterdayMissing.length} not typed</span>
                : yesterdayLastWeek ? <Chg c={change(g.yesterdayTotal, yesterdayLastWeek)} suffix="vs last week" /> : null}
            </div>
            <GoldSpark values={last14} id="sp-yday" label="Daily sales, last 14 days" />
          </div>
          <div className="card biz-kpi">
            <div className="label">{monthLabel(today.slice(0, 7)).split(" ")[0]}</div>
            <div className="value"><CountUp cents={g.mtd} compact /></div>
            <div className="sub"><Chg c={g.change} suffix={`vs ${lastMonthName}`} /></div>
            <GoldSpark values={months.map((m) => m.cents)} id="sp-month" label="Monthly sales, last 13 months" />
          </div>
          <div className="card biz-kpi biz-goal">
            <Ring frac={g.lastMonthTotal ? g.mtd / g.lastMonthTotal : 0} label={g.lastMonthTotal ? `${Math.round((g.mtd / g.lastMonthTotal) * 100)}%` : "–"} sub={`of ${lastMonthName}`} />
            <div>
              <div className="label">{gap > 0 ? `Beat ${lastMonthName}` : `Past ${lastMonthName}`}</div>
              <div className="value">{gap > 0 ? <>{compact(ctx.needPerDay ?? 0)}<small>/day</small></> : "✓"}</div>
              <div className="sub muted">{gap > 0 ? `${ctx.daysLeft} day${ctx.daysLeft === 1 ? "" : "s"} left` : compact(g.mtd - g.lastMonthTotal) + " ahead"}</div>
            </div>
          </div>
        </div>

        <div className="card biz-picks">
          <h2>Today&apos;s promo picks</h2>
          {/* loads the serif used on the promo photos */}
          <span className={serif.className} aria-hidden style={{ position: "absolute", opacity: 0, pointerEvents: "none" }}>Aa</span>
          {signals.length > 0 && <div className="biz-signals">{signals.map((x) => <span key={x.text} className={x.tone ?? ""} title={x.title}>{x.text}</span>)}</div>}
          {ideas.missing && <p className="small muted">Promo ideas start once update-0086 is run.</p>}
          {!ideas.missing && picks.length === 0 && <p className="small muted">No ideas yet: the Service log needs a few more weeks.</p>}
          <div className="biz-pickgrid">
            {picks.map(({ idea, today: why, badge }) => (
              <div key={idea.id} className="biz-pick">
                <PromoMockup idea={idea} endsOn={addDays(today, 13)} serif={serif.style.fontFamily} />
                <span className="tag">{KIND[idea.kind]}</span>
                <b>{idea.title}</b>
                <span className="m">{idea.items.length === 1 ? `${adName(idea.items[0].name)} ${idea.items[0].paid}${idea.items[0].free ? ` + ${idea.items[0].free}` : ""}` : idea.items.map((i) => `${i.paid + i.free} ${adName(i.name)}`).join(" + ")}</span>
                <span className="p">{peso(idea.price)} <small>· {sessionsOf(idea.items)} sessions</small></span>
                <span className="why" title={why}>{badge}</span>
                {ownerGm && <Link className="button small biz-open" href={`/promos?idea=${encodeURIComponent(idea.id)}`}>Open in builder</Link>}
              </div>
            ))}
          </div>
          {promo && (promo.promos.length > 0 || promo.due.length > 0) && (
            <div className="biz-promo-row">
              {promo.promos.map((p) => (
                ownerGm ? <Link key={p.id} className="biz-promo" href={`/promos/${p.id}`}>{p.title} <b>{p.active}</b></Link> : <span key={p.id} className="biz-promo">{p.title} <b>{p.active}</b></span>
              ))}
              {promo.due.slice(0, 8).map(({ c, next, promo: t }) => (
                <Link key={c.id} className="biz-due" href={`/promos/client/${c.id}`} title={`${t}: ${promo.names[next.s] ?? "session"} ${next.n}${bName[c.branch_id] ? ` · ${bName[c.branch_id]}` : ""}`}>
                  💬 {c.client_name} <span className={`chg ${next.late > 0 ? "down" : "neu"}`}>{next.late > 0 ? `${next.late}d late` : "today"}</span>
                </Link>
              ))}
              {promo.due.length > 8 && <span className="biz-promo">+{promo.due.length - 8}</span>}
            </div>
          )}
        </div>

        <div className="biz-row">
          <div className="card">
            <h2>Weekly sales <small>12 weeks</small></h2>
            <GoldArea id="wk" title="Weekly sales, last 12 weeks" points={weeks.map((w, i) => ({ label: (weeks.length - 1 - i) % 3 === 0 ? shortDay(w.start) : "", tip: `Week of ${shortDay(w.start)}`, cents: w.cents, partial: w.partial }))} />
          </div>
          <div className="card">
            <h2>Branches <small>{monthLabel(today.slice(0, 7)).split(" ")[0]} vs {lastMonthName}</small></h2>
            <BarRows rows={g.branches.map((b) => ({ key: b.id, name: b.name, href: `/?p=month&branch=${sb.find((x) => x.id === b.id)?.code ?? ""}`, cents: b.mtd, pill: <Chg c={b.change} /> }))} />
            <h2 style={{ marginTop: 18 }}>Best days <small>avg day</small></h2>
            <DayColumns days={wk} />
          </div>
        </div>

        <div className="biz-row">
          <div className="card">
            <h2>Every day <small>12 weeks</small></h2>
            <HeatCalendar weeks={cal} max={calMax} />
          </div>
          <div className="card">
            <h2>What sells <small>28 days</small></h2>
            {mix.list.length === 0 ? <p className="small muted">No Service log entries yet.</p> : (
              <Donut items={mix.list.filter((x) => x.cents > 0).map((x) => ({ name: x.name, cents: x.cents, change: mixHasPrev && x.prevCents > 0 ? change(x.cents, x.prevCents) : undefined }))}
                center={mix.total ? `${Math.round(((mix.hiko || mix.list[0].cents) / mix.total) * 100)}%` : "–"} sub={mix.hiko ? "Hiko" : mix.list[0]?.name ?? ""} />
            )}
          </div>
        </div>

        <div className="biz-row">
          <div className="card">
            <h2>Monthly sales <small>dashed = last year</small></h2>
            <GoldBars id="mo" title="Monthly sales, last 13 months" ghost={yearAgo}
              bars={months.map((m, i) => ({ key: m.ym, tip: monthLabel(m.ym), cents: m.cents, partial: m.partial, label: i % 2 === months.length % 2 || i === months.length - 1 ? monthLabel(m.ym).slice(0, 3) : null }))} />
          </div>
          <div className="card">
            <h2>Bookings <small>28 days</small></h2>
            {bk.past === 0 && bk.csrs.length === 0 ? <p className="small muted">No bookings yet.</p> : (
              <div className="biz-book">
                <Ring frac={bk.showRate ?? 0} label={bk.showRate === null ? "–" : `${Math.round(bk.showRate * 100)}%`} sub="showed up" size={124} color="var(--good)" />
                <ul>
                  <li>📅 <b>{bk.past}</b> appointments</li>
                  <li>📵 <b>{bk.unresponsive}</b> {bk.unresponsive > 0 ? <Link href="/bookings/followups">unresponsive</Link> : "unresponsive"}</li>
                  {bk.busiest && <li>⭐ <b>{bk.busiest}</b> most booked</li>}
                </ul>
              </div>
            )}
            {bk.csrs.length > 0 && (
              <div className="biz-csr">
                {bk.csrs.slice(0, 5).map((x) => (
                  <div key={x.name} title={`${x.name}: booked ${x.made}, ${x.past} appointments, ${x.showed} showed up`}>
                    <span className="br-av">{initial(x.name)}</span><span className="br-name">{x.name}</span><b>{x.made}</b>
                    <span className={`chg ${x.past && x.showed / x.past >= 0.7 ? "up" : "neu"}`}>{x.past ? `${Math.round((x.showed / x.past) * 100)}%` : "–"}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="card">
          <h2>Team <small>sales led · 28 days</small></h2>
          {topStaff.length === 0 ? <p className="small muted">No services logged in the last 28 days.</p> : (
            <BarRows rows={topStaff.map((x) => ({
              key: x.id, name: x.name, avatar: initial(x.name), cents: x.sales,
              pill: x.lateMin > 0 ? <span className="chg down" title={`${x.lates} late${x.lates === 1 ? "" : "s"}, ${x.lateMin} minutes`}>⏰ {x.lateMin}m</span> : null,
            }))} />
          )}
          {staff.length > 0 && (
            <details className="small biz-more">
              <summary>All numbers</summary>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Name</th><th>Branch</th><th className="num">Led</th><th className="num">Assisted</th><th className="num">Sales led</th><th className="num">Commission</th><th className="num">Lates</th></tr></thead>
                  <tbody>
                    {staff.map((x) => (
                      <tr key={x.id}><td>{x.name}</td><td>{x.branch}</td><td className="num">{x.lead}</td><td className="num">{x.assist}</td><td className="num">{peso(x.sales)}</td><td className="num">{peso(x.commission)}</td><td className="num">{x.lates ? `${x.lates} (${x.lateMin} min)` : "–"}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </div>
      </main>
    </>
  );
}
