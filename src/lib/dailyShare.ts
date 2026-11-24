import { centsToPhp } from "./csv";

/** One branch's day for the summary: recorded cents, or a Zero sales / Closed mark, or nothing yet. */
export type ShareCell = { cents: number | null; mark: string | null; staged: boolean };

const php = (c: number) => centsToPhp(c).replace(/\.00$/, "");
const longDate = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString("en-PH", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric" });
const monthName = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-PH", { timeZone: "UTC", month: "short" });

/**
 * The text sent to the management chat for one day: each branch in order, the day total, the month to date
 * and the daily average (days with sales or Zero sales; Closed and empty days left out). Recorded data only.
 */
export type DailySummary = {
  date: string; dateLong: string; dateShort: string; month: string; monthLong: string;
  branches: { name: string; value: string; cents: number | null }[];
  dayTotal: string; missing: number; monthToDate: string; dailyAverage: string;
};

/** The figures for one day, as shown on the shared image and text. Recorded data only. */
export function dailySummary(day: string, branches: { id: string; name: string }[], dates: string[],
  cellOf: (branch: string, date: string) => ShareCell | undefined): DailySummary {
  const upTo = dates.filter((d) => d <= day);
  const rows = branches.map((b) => {
    const c = cellOf(b.id, day);
    const value = c?.cents != null ? php(c.cents)
      : c?.mark === "CLOSED" ? "Closed" : c?.mark === "NO_SALES" ? "Zero sales" : c?.staged ? "Waiting" : "Not in yet";
    return { name: b.name.replace(/ \(.*\)$/, ""), value, cents: c?.cents ?? null };
  });
  const dayTotal = branches.reduce((s, b) => s + (cellOf(b.id, day)?.cents ?? 0), 0);
  let mtd = 0, counted = 0;
  for (const d of upTo) {
    let any = false;
    for (const b of branches) {
      const c = cellOf(b.id, d);
      if (c?.cents != null) { mtd += c.cents; any = true; } else if (c?.mark === "NO_SALES") any = true;
    }
    if (any) counted++;
  }
  const dt = new Date(`${day}T00:00:00Z`);
  const f = (o: Intl.DateTimeFormatOptions) => dt.toLocaleDateString("en-PH", { timeZone: "UTC", ...o });
  return {
    date: day, dateLong: f({ weekday: "long", month: "short", day: "numeric", year: "numeric" }), dateShort: f({ weekday: "short", month: "short", day: "numeric" }),
    month: f({ month: "short" }), monthLong: f({ month: "long" }),
    branches: rows, dayTotal: php(dayTotal),
    missing: branches.filter((b) => { const c = cellOf(b.id, day); return c?.cents == null && !c?.mark; }).length,
    monthToDate: php(mtd), dailyAverage: counted ? php(Math.round(mtd / counted / 100) * 100) : "–",
  };
}

export function dailyShareText(day: string, branches: { id: string; name: string }[], dates: string[],
  cellOf: (branch: string, date: string) => ShareCell | undefined): string {
  const upTo = dates.filter((d) => d <= day);
  const lines = branches.map((b) => {
    const c = cellOf(b.id, day);
    const v = c?.cents != null ? php(c.cents)
      : c?.mark === "CLOSED" ? "Closed" : c?.mark === "NO_SALES" ? "Zero sales" : c?.staged ? "waiting for sign-off" : "not entered yet";
    return `${b.name.replace(/ \(.*\)$/, "")}: ${v}`;
  });
  const dayTotal = branches.reduce((s, b) => s + (cellOf(b.id, day)?.cents ?? 0), 0);
  let mtd = 0, counted = 0;
  for (const d of upTo) {
    let any = false;
    for (const b of branches) {
      const c = cellOf(b.id, d);
      if (c?.cents != null) { mtd += c.cents; any = true; } else if (c?.mark === "NO_SALES") any = true;
    }
    if (any) counted++;
  }
  const missing = branches.filter((b) => { const c = cellOf(b.id, day); return c?.cents == null && !c?.mark; }).length;
  return [
    `Hermosa Daily Sales, ${longDate(day)}`,
    "",
    ...lines,
    "",
    `Day total: ${php(dayTotal)}${missing ? ` (${missing} branch${missing === 1 ? "" : "es"} not in yet)` : ""}`,
    `${monthName(day)} to date: ${php(mtd)}`,
    `Daily average (${monthName(day)}): ${counted ? php(Math.round(mtd / counted / 100) * 100) : "–"}`,
    "",
    "Sent from Hermosa OS",
  ].join("\n");
}
