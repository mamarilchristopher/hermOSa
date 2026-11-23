export const MANILA = "Asia/Manila";

/** Today's business date in Manila as YYYY-MM-DD. */
export function manilaToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: MANILA, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function isIsoDate(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function formatManila(ts: string): string {
  return new Intl.DateTimeFormat("en-PH", { timeZone: MANILA, dateStyle: "medium", timeStyle: "short" }).format(new Date(ts));
}
