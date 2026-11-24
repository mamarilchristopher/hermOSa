// Management Home: yesterday per branch, month pace vs last month, and what needs doing.
// Pure functions over daily_sales_status rows. Money in centavos, dates are Manila business dates.
// Zero sales days count as ₱0; Closed and empty days are left out of averages (same rule as the Daily Sales grid).
import { addDays, addMonths, daysBetween, monthEnd, monthStart, weekday } from "./insights";

/** [branch, date, recorded cents, mark CLOSED|NO_SALES, staged, service log cents] as daily_sales_status returns it. */
export type StatusDay = [string, string, number | null, string | null, boolean, number | null];
export type GlanceBranch = { id: string; name: string };

export type DayCell =
  | { kind: "sales"; cents: number }
  | { kind: "zero" }
  | { kind: "closed" }
  | { kind: "waiting" } // uploaded, waiting for sign-off
  | { kind: "empty" };

export type BranchGlance = {
  id: string; name: string;
  yesterday: DayCell;
  /** Yesterday vs this branch's daily average this month (before yesterday), as a fraction. null when not comparable. */
  vsAvg: number | null;
  today: number | null;
  mtd: number;
  /** Same days last month (1st to the same day number). */
  lastSame: number;
  change: number | null;
  avg: number | null;
  emptyDays: string[];
};

export type Glance = {
  today: string; yesterday: string;
  /** Last complete day counted in month figures (yesterday), or null on the 1st. */
  through: string | null;
  branches: BranchGlance[];
  yesterdayTotal: number;
  yesterdayMissing: string[];
  mtd: number; lastSame: number; change: number | null;
  lastMonthTotal: number;
  lastSameMonth: string; // YYYY-MM of last month
  pace: number | null; // each branch's daily average this month x days in the month (empty days don't drag it down)
  todaySoFar: number;
  emptyDays: number;
  best: { name: string; change: number } | null;
  worst: { name: string; change: number } | null;
};

const pct = (cur: number, base: number) => (base > 0 ? (cur - base) / base : null);

export function cellOf(rec: StatusDay | undefined): DayCell {
  if (!rec) return { kind: "empty" };
  const [, , cents, mark, staged] = rec;
  if (cents !== null) return { kind: "sales", cents: Number(cents) };
  if (mark === "NO_SALES") return { kind: "zero" };
  if (mark === "CLOSED") return { kind: "closed" };
  if (staged) return { kind: "waiting" };
  return { kind: "empty" };
}
const centsOf = (c: DayCell): number | null => (c.kind === "sales" ? c.cents : c.kind === "zero" ? 0 : null);

/** First day to ask for: today minus one month's start, so one daily_sales_status call covers both months. */
export const glanceFetchStart = (today: string) => monthStart(addMonths(monthStart(today), -1));

export function computeGlance(today: string, branches: GlanceBranch[], days: StatusDay[]): Glance {
  const yesterday = addDays(today, -1);
  const start = monthStart(today);
  const through = yesterday >= start ? yesterday : null;
  const lastStart = addMonths(start, -1);
  const lastEnd = monthEnd(lastStart);
  const n = through ? daysBetween(start, through) : 0;
  const lastSameEnd = n ? (addDays(lastStart, n - 1) > lastEnd ? lastEnd : addDays(lastStart, n - 1)) : null;
  const at = new Map(days.map((d) => [`${d[0]}|${d[1]}`, d]));

  const list: BranchGlance[] = branches.map((b) => {
    let mtd = 0, lastSame = 0, avgSum = 0, avgN = 0, counted = 0;
    const emptyDays: string[] = [];
    for (let d = start; through && d <= through; d = addDays(d, 1)) {
      const c = cellOf(at.get(`${b.id}|${d}`));
      const v = centsOf(c);
      if (v !== null) { mtd += v; counted += 1; }
      if (c.kind === "empty") emptyDays.push(d);
      if (v !== null && d < yesterday) { avgSum += v; avgN += 1; }
    }
    for (let d = lastStart; lastSameEnd && d <= lastSameEnd; d = addDays(d, 1)) lastSame += centsOf(cellOf(at.get(`${b.id}|${d}`))) ?? 0;
    const y = cellOf(at.get(`${b.id}|${yesterday}`));
    const before = avgN ? avgSum / avgN : null;
    const yv = centsOf(y);
    const t = cellOf(at.get(`${b.id}|${today}`));
    return {
      id: b.id, name: b.name, yesterday: y,
      vsAvg: yv !== null && before ? pct(yv, before) : null,
      today: t.kind === "sales" ? t.cents : null,
      mtd, lastSame, change: pct(mtd, lastSame), avg: counted ? Math.round(mtd / counted) : null,
      emptyDays,
    };
  });

  let lastMonthTotal = 0;
  for (const b of branches) for (let d = lastStart; d <= lastEnd; d = addDays(d, 1)) lastMonthTotal += centsOf(cellOf(at.get(`${b.id}|${d}`))) ?? 0;
  const mtd = list.reduce((s, b) => s + b.mtd, 0);
  const lastSame = list.reduce((s, b) => s + b.lastSame, 0);
  const ranked = list.filter((b) => b.change !== null).sort((a, b) => b.change! - a.change!);
  return {
    today, yesterday, through, branches: list,
    yesterdayTotal: list.reduce((s, b) => s + (centsOf(b.yesterday) ?? 0), 0),
    yesterdayMissing: through ? list.filter((b) => b.yesterday.kind === "empty").map((b) => b.name) : [],
    mtd, lastSame, change: pct(mtd, lastSame), lastMonthTotal, lastSameMonth: lastStart.slice(0, 7),
    pace: n ? Math.round(list.reduce((s, b) => s + (b.avg ?? 0), 0) * daysBetween(start, monthEnd(start))) : null,
    todaySoFar: list.reduce((s, b) => s + (b.today ?? 0), 0),
    emptyDays: list.reduce((s, b) => s + b.emptyDays.length, 0),
    best: ranked.length > 1 ? { name: ranked[0].name, change: ranked[0].change! } : null,
    worst: ranked.length > 1 ? { name: ranked[ranked.length - 1].name, change: ranked[ranked.length - 1].change! } : null,
  };
}

const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Mon, Nov 23" */
export const dayLabel = (d: string) => `${WD[weekday(d)]}, ${MO[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;
