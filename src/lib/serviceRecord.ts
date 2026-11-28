// CHRIS Nov 26: one service log entry as a record anyone on staff can open and save as a photo,
// to send to the client or management as proof. No commission on it (clients see it).
export type RecordLine = { service: string; session: number; amount: number; kind: string };
export type ServiceRecord = {
  id: string; branch: string; date: string; client: string;
  service: string; session: number; amount: number; kind: string; // PAID, BACKJOB, CHECKUP, NO_CHARGE
  priceNote: string | null; doneBy: string | null; assistedBy: string | null;
  status: string; enteredBy: string; enteredAt: string;
  /** v0.102.2: "Approved by X · Nov 26, 2026 · 4:15 PM", "Rejected by …" or "Pending approval". */
  decided?: string;
  /** update-0103: the account the payment went to, e.g. "BPI". */
  paidTo?: string | null;
  /** Every line of this client's visit that day (this entry included), e.g. a service and its meds. */
  visit: RecordLine[];
};

export const KIND_TEXT: Record<string, string> = { PAID: "Paid", BACKJOB: "Backjob (unpaid)", CHECKUP: "Check-up (unpaid)", NO_CHARGE: "No charge" };
export const php = (cents: number) => `₱${(cents / 100).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const recordDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-PH", { timeZone: "UTC", weekday: "short", month: "long", day: "numeric", year: "numeric" });
export const recordRef = (id: string) => `SL-${id.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
export const lineName = (l: { service: string; session: number }) => (l.session > 1 ? `${l.service} (session ${l.session})` : l.service);
export const visitTotal = (r: ServiceRecord) => r.visit.reduce((s, l) => s + l.amount, 0);
/** The approval line as a details row: ["Approved by", "Geraldine · Nov 26, 2026 · 4:15 PM"] or ["Approval", "Pending approval"]. */
export const decidedRow = (r: ServiceRecord): [string, string][] => {
  if (!r.decided) return [];
  const m = /^(Approved|Rejected)( by)? ?(.*)$/.exec(r.decided);
  if (!m) return [["Approval", r.decided]];
  return [[`${m[1]}${m[2] ?? ""}`, m[3].replace(/^· /, "") || m[1]]];
};
