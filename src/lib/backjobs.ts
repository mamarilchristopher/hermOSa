/** Backjob tracking (update-0088, CHRIS Nov 27): what needed fixing, and totals per staff, client and service. */
export const BACKJOB_REASONS: { v: string; label: string }[] = [
  { v: "UNEVEN", label: "Uneven / not symmetric" },
  { v: "THREAD", label: "Thread showing or loose" },
  { v: "SWELLING", label: "Swelling or bruising" },
  { v: "REACTION", label: "Skin reaction" },
  { v: "FADED", label: "Result faded early" },
  { v: "NOT_SATISFIED", label: "Client not satisfied" },
  { v: "OTHER", label: "Other" },
];
export const reasonText = (v: string | null | undefined) => BACKJOB_REASONS.find((r) => r.v === v)?.label ?? "Not given";

/** Same client = same name, ignoring case and extra spaces (the Service log has no client IDs). */
export const clientKey = (name: string | null | undefined) => (name ?? "").trim().replace(/\s+/g, " ").toLowerCase();

export type BackjobRow = { id: string; date: string; client: string; serviceId: string; staffId: string | null; reason: string | null };
export type Tally = { key: string; count: number; reasons: Record<string, number>; last: string };

/** Count backjobs by a key (staff, client, service), most first; ties go to the most recent. */
export function tally(rows: BackjobRow[], keyOf: (r: BackjobRow) => string | null): Tally[] {
  const m = new Map<string, Tally>();
  for (const r of rows) {
    const k = keyOf(r);
    if (!k) continue;
    const t = m.get(k) ?? { key: k, count: 0, reasons: {}, last: "" };
    t.count += 1;
    const why = r.reason ?? "NONE";
    t.reasons[why] = (t.reasons[why] ?? 0) + 1;
    if (r.date > t.last) t.last = r.date;
    m.set(k, t);
  }
  return [...m.values()].sort((a, b) => b.count - a.count || b.last.localeCompare(a.last));
}
/** The most common reason in a tally, as text. */
export function topReason(t: Tally): string {
  const best = Object.entries(t.reasons).filter(([k]) => k !== "NONE").sort((a, b) => b[1] - a[1])[0];
  return best ? reasonText(best[0]) : "";
}
/** Backjob rate: backjobs ÷ paid treatments they led, as a fraction (null under 5 treatments: too few to judge). */
export const rate = (backjobs: number, treatments: number) => (treatments >= 5 ? backjobs / treatments : null);

/** Backjob cases (update-0090, CHRIS Nov 27): one client's issue with one treatment, from first backjob to closing. */
export const CASE_STATUSES: { v: string; label: string; closed: boolean; tone: "warn" | "neu" | "up" | "down" }[] = [
  { v: "OPEN", label: "Open", closed: false, tone: "down" },
  { v: "IN_PROGRESS", label: "Being fixed", closed: false, tone: "warn" },
  { v: "RESOLVED", label: "Fixed", closed: true, tone: "up" },
  { v: "REFUNDED", label: "Refunded", closed: true, tone: "neu" },
  { v: "QUITCLAIM", label: "Quitclaim signed", closed: true, tone: "neu" },
  { v: "NO_RESPONSE", label: "Client stopped responding", closed: true, tone: "neu" },
];
export const caseStatus = (v: string | null | undefined) => CASE_STATUSES.find((s) => s.v === v) ?? CASE_STATUSES[0];
export const isClosed = (v: string | null | undefined) => caseStatus(v).closed;
/** Whole days between two YYYY-MM-DD dates (0 when the same day or reversed). */
export function daysBetween(from: string, to: string): number {
  const d = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
  return Number.isFinite(d) && d > 0 ? d : 0;
}
/** Open cases first (oldest first: they have waited longest), then closed ones, most recently closed first. */
export function sortCases<T extends { status: string; opened_on: string; closed_on: string | null }>(cases: T[]): T[] {
  return [...cases].sort((a, b) => {
    const ca = isClosed(a.status), cb = isClosed(b.status);
    if (ca !== cb) return ca ? 1 : -1;
    return ca ? (b.closed_on ?? "").localeCompare(a.closed_on ?? "") : a.opened_on.localeCompare(b.opened_on);
  });
}
