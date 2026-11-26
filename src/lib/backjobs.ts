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
