/**
 * Business dashboard (CHRIS Nov 27): sales and trends, employee patterns and today's promo picks, for all management.
 * Pure functions over daily_sales_status rows (the same figures as Home and Daily Sales), the Service log, Late NTEs and
 * bookings. Money in centavos, dates are Manila business dates (YYYY-MM-DD).
 */
import { cellOf, type StatusDay } from "./homeGlance";
import { addDays, monthStart, weekday, WEEKDAYS } from "./insights";
import type { Suggestion } from "./promoRules";

export const centsOfCell = (r: StatusDay | undefined): number | null => {
  const c = cellOf(r);
  return c.kind === "sales" ? c.cents : c.kind === "zero" ? 0 : null;
};

/** Company total per day (null = no branch has a figure for that day). */
export function companyDays(days: StatusDay[], branchIds: string[]): Map<string, number | null> {
  const ids = new Set(branchIds);
  const out = new Map<string, number | null>();
  for (const r of days) {
    if (!ids.has(r[0])) continue;
    const v = centsOfCell(r);
    if (v === null) { if (!out.has(r[1])) out.set(r[1], null); continue; }
    out.set(r[1], (out.get(r[1]) ?? 0) + v);
  }
  return out;
}

/** Monday of the week a date is in. */
export const weekStart = (d: string) => addDays(d, -((weekday(d) + 6) % 7));

export function weeklyTotals(byDay: Map<string, number | null>, today: string, weeks = 12) {
  const first = addDays(weekStart(today), -7 * (weeks - 1));
  return Array.from({ length: weeks }, (_, k) => {
    const start = addDays(first, 7 * k);
    let cents = 0;
    for (let i = 0; i < 7; i++) cents += byDay.get(addDays(start, i)) ?? 0;
    return { start, cents, partial: k === weeks - 1 };
  });
}

export function monthlyTotals(byDay: Map<string, number | null>, today: string, months = 13) {
  const sums = new Map<string, number>();
  for (const [d, v] of byDay) sums.set(d.slice(0, 7), (sums.get(d.slice(0, 7)) ?? 0) + (v ?? 0));
  const out: { ym: string; cents: number; partial: boolean }[] = [];
  let ym = today.slice(0, 7);
  for (let i = 0; i < months; i++) {
    out.unshift({ ym, cents: sums.get(ym) ?? 0, partial: i === 0 });
    const [y, m] = ym.split("-").map(Number);
    ym = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  }
  return out;
}

/** Average company sales per weekday over the last `weeks` complete weeks (days with figures only). */
export function weekdayAverages(byDay: Map<string, number | null>, today: string, weeks = 12) {
  const sum = Array(7).fill(0), n = Array(7).fill(0);
  for (let d = addDays(today, -7 * weeks); d < today; d = addDays(d, 1)) {
    const v = byDay.get(d);
    if (v === null || v === undefined) continue;
    sum[weekday(d)] += v; n[weekday(d)] += 1;
  }
  return [1, 2, 3, 4, 5, 6, 0].map((day) => ({ day, avg: n[day] ? Math.round(sum[day] / n[day]) : null }));
}

/** "Brilliant 10+3", "Brilliant Single Session", "Brilliant · Glow Year" → "Brilliant". */
export function serviceFamily(name: string): string {
  return name.replace(/\s*·.*$/, "").replace(/\s*\(.*\)\s*$/, "").replace(/\s+\d+\s*\+\s*\d+.*$/, "").replace(/\s+single session$/i, "").trim() || name;
}

export type LogLite = { id: string; branch_id: string; service_date: string; service_id: string; amount_paid_cents: number; performer_id: string; assistant_id: string | null; commission_type: string; visit_kind?: string | null };

/** Services by family: last 28 days against the 28 before, by sales and count. */
export function serviceMix(logs: LogLite[], names: Record<string, string>, today: string) {
  const cut = addDays(today, -27), prevCut = addDays(today, -55);
  const fam = new Map<string, { name: string; cents: number; n: number; prevCents: number; prevN: number }>();
  for (const l of logs) {
    if (l.service_date < prevCut || l.service_date > today) continue;
    const f = serviceFamily(names[l.service_id] ?? "Other");
    const x = fam.get(f) ?? { name: f, cents: 0, n: 0, prevCents: 0, prevN: 0 };
    if (l.service_date >= cut) { x.cents += Number(l.amount_paid_cents); x.n += 1; } else { x.prevCents += Number(l.amount_paid_cents); x.prevN += 1; }
    fam.set(f, x);
  }
  const list = [...fam.values()].sort((a, b) => b.cents - a.cents || b.n - a.n);
  const total = list.reduce((s, x) => s + x.cents, 0);
  return { list, total, hiko: list.filter((x) => /hiko/i.test(x.name)).reduce((s, x) => s + x.cents, 0) };
}

export type Staff = { id: string; name: string; branch: string; lead: number; assist: number; sales: number; commission: number; lates: number; lateMin: number };
export function staffPatterns(
  logs: LogLite[], lines: { employee_id: string; amount_cents: number }[], lates: { employee_id: string; late_minutes: number }[],
  people: { id: string; name: string; branch: string }[], from: string,
): Staff[] {
  const m = new Map<string, Staff>(people.map((p) => [p.id, { ...p, lead: 0, assist: 0, sales: 0, commission: 0, lates: 0, lateMin: 0 }]));
  for (const l of logs) {
    if (l.service_date < from) continue;
    const lead = m.get(l.performer_id);
    if (lead) { lead.lead += 1; lead.sales += Number(l.amount_paid_cents); }
    const a = l.assistant_id ? m.get(l.assistant_id) : null;
    if (a) a.assist += 1;
  }
  for (const x of lines) { const s = m.get(x.employee_id); if (s) s.commission += Number(x.amount_cents); }
  for (const x of lates) { const s = m.get(x.employee_id); if (s) { s.lates += 1; s.lateMin += x.late_minutes; } }
  return [...m.values()].filter((s) => s.lead + s.assist + s.lates > 0).sort((a, b) => b.sales - a.sales || b.lead - a.lead);
}

export type Booking = { csr_employee_id: string | null; booked_on: string; appointment_date: string; status: string; branch_id: string };
export function bookingPatterns(rows: Booking[], names: Record<string, string>, from: string, today: string) {
  const past = rows.filter((b) => b.appointment_date >= from && b.appointment_date < today && b.status !== "CANCELLED");
  const showed = past.filter((b) => b.status === "ARRIVED" || b.status === "DONE").length;
  const unresponsive = past.filter((b) => b.status === "UNRESPONSIVE").length;
  const per = new Map<string, { name: string; made: number; past: number; showed: number }>();
  for (const b of rows) {
    if (!b.csr_employee_id) continue;
    const x = per.get(b.csr_employee_id) ?? { name: names[b.csr_employee_id] ?? "Unknown", made: 0, past: 0, showed: 0 };
    if (b.booked_on >= from) x.made += 1;
    if (b.appointment_date >= from && b.appointment_date < today && b.status !== "CANCELLED") {
      x.past += 1;
      if (b.status === "ARRIVED" || b.status === "DONE") x.showed += 1;
    }
    per.set(b.csr_employee_id, x);
  }
  const byWeekday = Array(7).fill(0);
  for (const b of past) byWeekday[weekday(b.appointment_date)] += 1;
  return {
    past: past.length, showRate: past.length ? showed / past.length : null, unresponsive,
    csrs: [...per.values()].filter((x) => x.made + x.past > 0).sort((a, b) => b.made - a.made),
    busiest: past.length ? WEEKDAYS[byWeekday.indexOf(Math.max(...byWeekday))] : null,
  };
}

/** Today's context for promo picks: payday, the weekday's usual strength, the month's pace and the branch that is behind. */
export type DayContext = {
  payday: boolean; weekdayName: string; weekdayAvg: number | null; overallAvg: number | null; weak: boolean; strong: boolean;
  daysLeft: number; needPerDay: number | null; behind: { name: string; change: number } | null;
};
export function dayContext(today: string, wk: { day: number; avg: number | null }[], o: { mtd: number; lastMonthTotal: number; worst: { name: string; change: number } | null; monthEnd: string }): DayContext {
  const dom = Number(today.slice(8, 10)), last = Number(o.monthEnd.slice(8, 10));
  // Sweldo: the 15th and the last day of the month, plus the day after each.
  const payday = dom === 15 || dom === 16 || dom === last || dom === 1;
  const vals = wk.map((w) => w.avg).filter((v): v is number => v !== null);
  const overall = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
  const mine = wk.find((w) => w.day === weekday(today))?.avg ?? null;
  const daysLeft = last - dom + 1;
  const gap = o.lastMonthTotal - o.mtd;
  return {
    payday, weekdayName: WEEKDAYS[weekday(today)], weekdayAvg: mine, overallAvg: overall,
    weak: mine !== null && overall !== null && mine < overall * 0.85, strong: mine !== null && overall !== null && mine > overall * 1.15,
    daysLeft, needPerDay: gap > 0 ? Math.round(gap / Math.max(1, daysLeft)) : null,
    behind: o.worst && o.worst.change < 0 ? o.worst : null,
  };
}

/** Rank this week's promo ideas for today: payday favors programs (bigger tickets), a slow weekday favors slow-seller
 *  and season bundles (easy yeses), otherwise the season leads. Returns the ideas with the reason for today. */
export function promoPicks(ideas: Suggestion[], ctx: DayContext, n = 3): { idea: Suggestion; today: string; badge: string }[] {
  const score = (s: Suggestion) =>
    (ctx.payday ? (s.kind === "PROGRAM" ? 4 : 1) : 0) + (ctx.weak ? (s.kind === "SLOW" ? 2 : s.kind === "SEASON" ? 1.5 : 0) : 0) +
    (s.kind === "SEASON" ? 1 : 0) + (!ctx.payday && !ctx.weak && s.kind === "PROGRAM" ? 0.5 : 0);
  // One pick per title: two services can share a seasonal title ("The Christmas Glow-Up").
  const seen = new Set<string>();
  const ranked = [...ideas].sort((a, b) => score(b) - score(a)).filter((s) => !seen.has(s.title) && !!seen.add(s.title));
  return ranked.slice(0, n).map((idea) => ({
    idea,
    today: ctx.payday && idea.kind === "PROGRAM" ? "Payday: clients have cash for a bigger, prepaid ticket."
      : ctx.weak && idea.kind !== "PROGRAM" ? `${ctx.weekdayName} is usually a slower day: an easy-yes bundle fills chairs.`
      : idea.kind === "SEASON" ? `${idea.season ?? "The season"} is coming: post it today so it's seen early.`
      : idea.kind === "SLOW" ? "This service has been quiet; a bonus session gives it a push."
      : "Keeps clients coming back all year.",
    // A two-word reason for the dashboard card (the sentence above is its hover text).
    badge: ctx.payday && idea.kind === "PROGRAM" ? "💸 Payday"
      : ctx.weak && idea.kind !== "PROGRAM" ? `📉 Slow ${ctx.weekdayName}`
      : idea.kind === "SEASON" ? `🎄 ${(idea.season ?? "Season").replace(/ season$/i, "")}`
      : idea.kind === "SLOW" ? "📈 Quiet service"
      : "🔁 All year",
  }));
}

export const monthEndOf = (d: string) => addDays(monthStart(addDays(monthStart(d), 32)), -1);
