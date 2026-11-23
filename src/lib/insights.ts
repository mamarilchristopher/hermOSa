// Sales insights computed from daily branch totals (historical_sales_daily).
// Pure functions: no I/O, all money in centavos, all dates are Manila business dates (YYYY-MM-DD).
// Nothing here estimates or fills gaps: a day with no recorded sales is reported as missing, never guessed.

export type DayRow = [branchId: string, date: string, cents: number];
/** A Closed / No sales mark. Only CONFIRMED marks (two people) stop a day counting as missing. */
export type ZeroMark = [branchId: string, date: string, status: "CLOSED" | "NO_SALES", state: "PENDING" | "CONFIRMED", id: string, markedBy: string, mine: boolean];
export type BranchInfo = { id: string; code: string; name: string; first_date: string | null };
export type Period = { key: PeriodKey; start: string; end: string; label: string };
export type PeriodKey = "month" | "lastmonth" | "ytd" | "12m" | "custom";

const DAY = 86_400_000;
const toMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const fromMs = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => fromMs(toMs(d) + n * DAY);
export const daysBetween = (a: string, b: string) => Math.round((toMs(b) - toMs(a)) / DAY) + 1; // inclusive
const minDate = (a: string, b: string) => (a < b ? a : b);
const maxDate = (a: string, b: string) => (a > b ? a : b);

/** Move a date by whole months, clamping to the month's last day (Mar 31 - 1 month = Feb 28/29). */
export function addMonths(d: string, n: number): string {
  const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7)) - 1 + n, day = Number(d.slice(8, 10));
  const ty = y + Math.floor(m / 12), tm = ((m % 12) + 12) % 12;
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return `${ty}-${String(tm + 1).padStart(2, "0")}-${String(Math.min(day, last)).padStart(2, "0")}`;
}
export const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
export const monthEnd = (d: string) => addDays(addMonths(monthStart(d), 1), -1);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const monthLabel = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const weekday = (d: string) => new Date(toMs(d)).getUTCDay();

/** Resolve the period from the query string. Default is the current month to date. */
export function resolvePeriod(key: string | undefined, start: string | undefined, end: string | undefined, today: string): Period {
  switch (key) {
    case "lastmonth": {
      const s = addMonths(monthStart(today), -1);
      return { key, start: s, end: monthEnd(s), label: monthLabel(s.slice(0, 7)) };
    }
    case "ytd":
      return { key, start: `${today.slice(0, 4)}-01-01`, end: today, label: `${today.slice(0, 4)} year to date` };
    case "12m":
      return { key, start: addDays(addMonths(today, -12), 1), end: today, label: "Last 12 months" };
    case "custom":
      if (start && end && start <= end && daysBetween(start, end) <= 3660) {
        return { key, start, end: minDate(end, today), label: `${start} to ${minDate(end, today)}` };
      }
  }
  return { key: "month", start: monthStart(today), end: today, label: `${monthLabel(today.slice(0, 7))} to date` };
}

/** The window to compare against: the same days one month back for monthly views, otherwise the window just before. */
export function previousWindow(p: { key: PeriodKey; start: string; end: string }): { start: string; end: string; label: string } {
  if (p.key === "month" || p.key === "lastmonth") {
    return { start: addMonths(p.start, -1), end: addMonths(p.end, -1), label: "same days last month" };
  }
  if (p.key === "ytd" || p.key === "12m") {
    return { start: addMonths(p.start, -12), end: addMonths(p.end, -12), label: "same days last year" };
  }
  const len = daysBetween(p.start, p.end);
  return { start: addDays(p.start, -len), end: addDays(p.start, -1), label: `previous ${len} days` };
}

export type Scope = {
  total: number;
  salesDays: number;
  avgPerDay: number | null;
  prev: number | null; // null = no recorded data in the comparison window
  lastYear: number | null;
  ytd: number;
  ytdLastYear: number | null;
  best: { date: string; cents: number } | null;
  months: { ym: string; cents: number; partial: boolean }[]; // last 13 months up to the period end
  missing: string[]; // dates with no recorded sales and not marked closed
  closedDays: number; // confirmed Closed / No sales days
  pendingMarks: number; // marked Closed / No sales, waiting for a second person
};

export type Insights = {
  period: Period;
  compareEnd: string; // last complete day used for comparisons
  prevLabel: string;
  company: Scope;
  branches: (Scope & { branch: BranchInfo; share: number | null })[];
  weekdays: { day: number; avg: number | null }[]; // company average per weekday over the last 12 months
  fetchStart: string;
};

/** Earliest date the insights need, so the caller fetches once. */
export function fetchStart(p: Period): string {
  const prev = previousWindow(p);
  return [prev.start, addMonths(p.start, -12), `${Number(p.end.slice(0, 4)) - 1}-01-01`, addMonths(monthStart(p.end), -12), addDays(addMonths(p.end, -12), 1)]
    .reduce(minDate);
}

export function computeInsights(input: {
  period: Period;
  today: string;
  branches: BranchInfo[];
  days: DayRow[];
  closed: ZeroMark[];
}): Insights {
  const { period, today, branches } = input;
  // Today is still open: comparisons and missing days stop at yesterday.
  const compareEnd = minDate(period.end, addDays(today, -1));
  // Every figure runs from the period start to the last complete day, so comparisons are like for like.
  const end = compareEnd;
  const prevWin = previousWindow({ ...period, end: end < period.start ? period.start : end });

  const byBranch = new Map<string, Map<string, number>>();
  for (const b of branches) byBranch.set(b.id, new Map());
  for (const [b, d, c] of input.days) byBranch.get(b)?.set(d, (byBranch.get(b)!.get(d) ?? 0) + Number(c));
  const closedBy = new Map<string, Set<string>>();
  const pendingBy = new Map<string, Set<string>>();
  for (const [b, d, , state] of input.closed) {
    const m = state === "CONFIRMED" ? closedBy : pendingBy;
    if (!m.has(b)) m.set(b, new Set());
    m.get(b)!.add(d);
  }

  const sumRange = (ids: string[], s: string, e: string) => {
    let total = 0, any = false;
    for (const id of ids) {
      for (const [d, c] of byBranch.get(id) ?? []) {
        if (d >= s && d <= e) {
          total += c;
          any = true;
        }
      }
    }
    return { total, any };
  };

  const yearStart = `${compareEnd.slice(0, 4)}-01-01`;
  const lyEnd = addMonths(compareEnd, -12);
  const monthsList: string[] = [];
  for (let i = 12; i >= 0; i--) monthsList.push(addMonths(monthStart(period.end), -i).slice(0, 7));

  const scope = (ids: string[]): Scope => {
    const cur = sumRange(ids, period.start, end);
    const daily = new Map<string, number>();
    for (const id of ids) {
      for (const [d, c] of byBranch.get(id) ?? []) if (d >= period.start && d <= end) daily.set(d, (daily.get(d) ?? 0) + c);
    }
    let best: Scope["best"] = null;
    for (const [d, c] of daily) if (!best || c > best.cents) best = { date: d, cents: c };
    const prev = sumRange(ids, prevWin.start, prevWin.end);
    const ly = sumRange(ids, addMonths(period.start, -12), lyEnd);
    const ytd = sumRange(ids, yearStart, end);
    const ytdLy = sumRange(ids, addMonths(yearStart, -12), lyEnd);
    const months = monthsList.map((ym) => ({
      ym,
      cents: sumRange(ids, `${ym}-01`, minDate(monthEnd(`${ym}-01`), end)).total,
      partial: ym === end.slice(0, 7) && end < monthEnd(end),
    }));
    const missing: string[] = [];
    let closedDays = 0, pendingMarks = 0;
    for (const id of ids) {
      const b = branches.find((x) => x.id === id);
      if (!b?.first_date) continue; // a branch with no data yet has nothing "missing"
      const from = maxDate(period.start, b.first_date);
      const days = byBranch.get(id)!;
      const closed = closedBy.get(id) ?? new Set();
      for (let d = from; d <= compareEnd; d = addDays(d, 1)) {
        if (days.has(d)) continue;
        if (closed.has(d)) {
          closedDays++;
          continue;
        }
        if (pendingBy.get(id)?.has(d)) pendingMarks++; // still missing until a second person confirms
        missing.push(ids.length > 1 ? `${b.code}:${d}` : d);
      }
    }
    return {
      total: cur.total,
      salesDays: daily.size,
      avgPerDay: daily.size ? Math.round(cur.total / daily.size) : null,
      prev: prev.any ? prev.total : null,
      lastYear: ly.any ? ly.total : null,
      ytd: ytd.total,
      ytdLastYear: ytdLy.any ? ytdLy.total : null,
      best,
      months,
      missing,
      closedDays,
      pendingMarks,
    };
  };

  const allIds = branches.map((b) => b.id);
  const company = scope(allIds);
  const perBranch = branches.map((b) => {
    const s = scope([b.id]);
    return { ...s, branch: b, share: company.total > 0 ? s.total / company.total : null };
  });

  // Weekday pattern: average recorded sales per weekday over the 12 months up to the last complete day.
  const wStart = addDays(addMonths(compareEnd, -12), 1);
  const totals = new Map<string, number>();
  for (const id of allIds) for (const [d, c] of byBranch.get(id) ?? []) if (d >= wStart && d <= compareEnd) totals.set(d, (totals.get(d) ?? 0) + c);
  const wsum = Array(7).fill(0), wcnt = Array(7).fill(0);
  for (const [d, c] of totals) {
    wsum[weekday(d)] += c;
    wcnt[weekday(d)]++;
  }
  const weekdays = [1, 2, 3, 4, 5, 6, 0].map((day) => ({ day, avg: wcnt[day] ? Math.round(wsum[day] / wcnt[day]) : null }));

  return { period, compareEnd, prevLabel: prevWin.label, company, branches: perBranch, weekdays, fetchStart: fetchStart(period) };
}

/** Percentage change, or null when there is nothing to compare against. */
export function change(cur: number, base: number | null): number | null {
  if (base === null || base === 0) return null;
  return (cur - base) / base;
}

/** Group sorted dates into runs, e.g. a 3-month gap shows as one line. */
export function dateRuns(dates: string[]): { from: string; to: string; days: number }[] {
  const runs: { from: string; to: string; days: number }[] = [];
  for (const d of [...dates].sort()) {
    const last = runs[runs.length - 1];
    if (last && addDays(last.to, 1) === d) {
      last.to = d;
      last.days++;
    } else runs.push({ from: d, to: d, days: 1 });
  }
  return runs;
}
