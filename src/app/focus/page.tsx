import Link from "next/link";
import { redirect } from "next/navigation";
import { can, requireAccess } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { manilaToday } from "@/lib/dates";
import { withApprovedSales } from "@/lib/approvedSales";
import { computeGlance, dayLabel, glanceFetchStart, type StatusDay } from "@/lib/homeGlance";
import { addDays, addMonths, monthStart, sortBranches } from "@/lib/insights";
import { companyDays, dayContext, monthEndOf, promoPicks, weekdayAverages } from "@/lib/business";
import { addonIdea, cutoffInfo, daySections, paydayNear, staffCheckins } from "@/lib/gmDay";
import { adName } from "@/lib/promoRules";
import { every } from "../business/load";
import { AddonCard } from "./AddonCard";
import { loadIdeas } from "../promos/ideas";
import { promoDue } from "../business/load";
import { DayList } from "./DayList";
import { IconBag, IconHandCoins, IconHandshake } from "@/components/Icons";

type DailyStatus = { ok: boolean; branches?: { id: string; code: string; name: string }[]; days?: StatusDay[] };
const count = (r: { count: number | null }) => r.count ?? 0;

/** My day (CHRIS Nov 27): the GM's daily reminders as a sales-driven manager, with live counts. Owners can open it too.
 *  Gentle reminders, no deadlines. Payday near: settle pending commissions. Frequent lates or backjobs: a check-in. */
export default async function MyDay() {
  const { supabase, access, branches } = await requireAccess();
  if (!(can(access, ["OWNER"], null) || can(access, ["MANAGER"], null))) redirect("/me");
  const today = manilaToday();
  const from28 = addDays(today, -27);
  const start = monthStart(addMonths(monthStart(today), -3)) < glanceFetchStart(today) ? monthStart(addMonths(monthStart(today), -3)) : glanceFetchStart(today);

  const from56 = addDays(today, -55);
  const [svcAll, logs56] = await Promise.all([
    supabase.from("services").select("*"),
    every<{ service_id: string; service_date: string }>((a, b) => supabase.from("service_logs").select("service_id, service_date")
      .eq("visit_kind", "PAID").gte("service_date", from56).lte("service_date", addDays(today, -1)).neq("state", "REJECTED").order("id").range(a, b)),
  ]);
  const [{ data: st }, bk, fu, drafts, live, signoff, payments, { data: lateData }, { data: bjData }, { data: empData }, ideas, promo] = await Promise.all([
    supabase.rpc("daily_sales_status", { p_start: start, p_end: today }),
    supabase.from("bookings").select("id", { count: "exact", head: true }).eq("appointment_date", today).in("status", ["BOOKED", "CONFIRMED", "ARRIVING", "ARRIVED", "DONE"]),
    supabase.from("bookings").select("id", { count: "exact", head: true }).eq("status", "UNRESPONSIVE"),
    supabase.from("promos").select("id", { count: "exact", head: true }).eq("state", "DRAFT"),
    supabase.from("promos").select("id, title, approved_at").eq("state", "APPROVED"),
    supabase.from("service_logs").select("id", { count: "exact", head: true }).eq("state", "PENDING"),
    supabase.from("payment_checks").select("service_log_id", { count: "exact", head: true }).eq("state", "PENDING"),
    supabase.from("late_ntes").select("employee_id, late_minutes").gte("work_date", from28).lte("work_date", today).neq("state", "VOID"),
    supabase.from("service_logs").select("id, performer_id").eq("visit_kind", "BACKJOB").gte("service_date", from28).neq("state", "REJECTED"),
    supabase.from("employees").select("id, full_name").eq("active", true),
    loadIdeas(supabase, today),
    promoDue(supabase, today),
  ]);

  const s = (st ?? { ok: false }) as DailyStatus;
  const sb = sortBranches(s.branches ?? []);
  const days = await withApprovedSales(supabase, s.days ?? [], today);
  const g = computeGlance(today, sb, days);
  const byDay = companyDays(days, sb.map((b) => b.id));
  const wk = weekdayAverages(byDay, today, 12);
  const ctx = dayContext(today, wk, { mtd: g.mtd, lastMonthTotal: g.lastMonthTotal, worst: g.worst, monthEnd: monthEndOf(today) });
  const picks = promoPicks(ideas.ideas, ctx, 3);

  // Approved promos two weeks or older that nobody has bought yet.
  const buyers = new Map((promo?.promos ?? []).map((p) => [p.id, p.active]));
  const liveRows = (live.data ?? []) as { id: string; title: string; approved_at: string | null }[];
  const liveNoBuyers = liveRows.filter((p) => p.approved_at && p.approved_at.slice(0, 10) <= addDays(today, -14) && !(buyers.get(p.id) ?? 0)).map((p) => p.title);

  const sections = daySections({
    bookingsToday: count(bk), followups: count(fu), promoDue: promo?.due.length ?? 0, picks: picks.length, drafts: count(drafts), liveNoBuyers,
    missingToday: s.ok ? g.branches.filter((b) => b.todayCell.kind === "empty").length : 0,
    missingYesterday: s.ok ? g.yesterdayMissing.length : 0,
    pendingSignoff: count(signoff), pendingPayments: count(payments),
    behind: ctx.behind?.name ?? null, needPerDay: ctx.needPerDay,
  }, { payday: ctx.payday, weak: ctx.weak, weekdayName: ctx.weekdayName });

  const cut = cutoffInfo(today);
  const near = paydayNear(today);
  const people = ((empData ?? []) as { id: string; full_name: string }[]).map((e) => ({ id: e.id, name: e.full_name }));
  // update-0088: a backjob counts for whoever did the first treatment (its tag), else whoever did the backjob.
  const bjRows = (bjData ?? []) as { id: string; performer_id: string }[];
  const { data: tagData } = bjRows.length ? await supabase.from("backjob_tags").select("service_log_id, staff_id").in("service_log_id", bjRows.map((b) => b.id)) : { data: [] };
  const tagStaff = new Map(((tagData ?? []) as { service_log_id: string; staff_id: string | null }[]).map((t) => [t.service_log_id, t.staff_id]));
  const checkins = staffCheckins(people, (lateData ?? []) as { employee_id: string; late_minutes: number }[],
    bjRows.map((b) => ({ performer_id: (tagStaff.has(b.id) ? tagStaff.get(b.id) : b.performer_id) ?? "" })));
  // Today's add-on idea: the same weekday over the last 8 weeks, the add-on services and how often they sell.
  type Svc = { id: string; name: string; price_cents: number | null; cost_cents?: number | null; is_addon?: boolean; is_meds?: boolean };
  const svcs = (svcAll.data ?? []) as Svc[];
  const svcById = new Map(svcs.map((x) => [x.id, x]));
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  const sameDay = logs56.filter((l) => new Date(`${l.service_date}T00:00:00Z`).getUTCDay() === dow);
  const isMain = (id: string) => { const x = svcById.get(id); return !!x && !x.is_addon && !x.is_meds; };
  const mainSame = sameDay.filter((l) => isMain(l.service_id));
  const topCount = new Map<string, number>();
  for (const l of mainSame) topCount.set(l.service_id, (topCount.get(l.service_id) ?? 0) + 1);
  const top = [...topCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([id, count]) => ({ name: adName(svcById.get(id)!.name), count, price: Number(svcById.get(id)!.price_cents ?? 0) }));
  const last28 = addDays(today, -28);
  const recent = logs56.filter((l) => l.service_date >= last28);
  const addonLogs = recent.filter((l) => svcById.get(l.service_id)?.is_addon);
  const mains28 = recent.filter((l) => isMain(l.service_id)).length;
  const idea = addonIdea({
    weekdayName: ctx.weekdayName, busy: ctx.strong, slow: ctx.weak, payday: ctx.payday,
    clientsToday: mainSame.length / 8,
    addons: svcs.filter((x) => x.is_addon && !x.is_meds).map((x) => ({ name: adName(x.name), price: Number(x.price_cents ?? 0), cost: x.cost_cents ?? null, sold28: addonLogs.filter((l) => l.service_id === x.id).length })),
    top, attach: mains28 ? addonLogs.length / mains28 : 0,
  });
  const unsettled = count(signoff) + count(payments);
  void branches;

  return (
    <>
      <TopBar access={access} />
      <main className="myday">
        <div className="biz-head"><h1>My day</h1><span className="muted">{dayLabel(today)} · reminders, no deadlines</span></div>

        {(near || checkins.length > 0 || ctx.payday) && (
          <div className="myday-heads">
            {near && (
              <Link href="/services" className={`myday-head ${unsettled ? "warn" : "ok"}`}>
                <IconHandCoins size={30} className="e" />
                <span><b>Payday {cut.daysLeft === 0 ? "is today" : `in ${cut.daysLeft} day${cut.daysLeft === 1 ? "" : "s"}`}</b>
                  {unsettled ? `Settle pending commissions: ${signoff.count ?? 0} entries to sign off, ${payments.count ?? 0} payments to confirm` : "All commissions are settled for this cutoff"}</span>
              </Link>
            )}
            {ctx.payday && !near && (
              <Link href="/business" className="myday-head ok"><IconBag size={30} className="e" /><span><b>Clients&apos; payday</b>Push year programs and prepaid packages today</span></Link>
            )}
            {checkins.slice(0, 4).map((c) => (
              <Link key={c.id} href={`/people/${c.id}`} className="myday-head soft">
                <IconHandshake size={30} className="e" />
                <span><b>Check in with {c.name.split(" ")[0]}</b>{c.why} in 4 weeks: invite a short talk or a staff checkup</span>
              </Link>
            ))}
          </div>
        )}

        {idea && <AddonCard idea={idea} />}
        <DayList sections={sections} today={today} />
      </main>
    </>
  );
}
