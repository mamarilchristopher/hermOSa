// Commission maths shared by the entry form preview. The database computes the stored amounts the same way.
export const RATE_BP = 500; // 5% of the amount paid
export const LEAD_SHARE_BP = 6000; // lead 60%, assistant 40%
export type CommissionType = "LEAD" | "ASSIST" | "SOLO" | "NONCOMMI";

const roundBp = (cents: number, bp: number) => Math.floor((cents * bp + 5000) / 10000);

/** fixedCents: the service's set commission (update-0042); without one it's 5% of the amount paid.
 *  priceCents: the list price. Paid less than it (a discount) earns 5% of the amount paid instead (update-0053). */
export function previewCommission(paidCents: number, type: CommissionType, fixedCents?: number | null, priceCents?: number | null) {
  // update-0068: a ₱0 session of a service priced ₱0 with a set commission (bundle sessions, later doses) still pays it.
  const zeroSession = paidCents === 0 && fixedCents != null && !priceCents;
  if (type === "NONCOMMI" || !(paidCents > 0 || zeroSession)) return { total: 0, lead: 0, assist: 0, solo: 0 };
  const discounted = priceCents != null && paidCents < priceCents;
  const total = fixedCents != null && !discounted ? fixedCents : roundBp(paidCents, RATE_BP);
  if (type === "SOLO") return { total, lead: 0, assist: 0, solo: total };
  const lead = roundBp(total, LEAD_SHARE_BP);
  return { total, lead, assist: total - lead, solo: 0 };
}

export const ROLE_TEXT: Record<string, string> = { SOLO: "solo", LEAD: "lead", ASSIST: "assist" };
export const TYPE_TEXT: Record<string, string> = { LEAD: "Lead + assist", SOLO: "Solo", NONCOMMI: "No commission" };
