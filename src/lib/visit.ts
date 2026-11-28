// update-0106 (CHRIS Nov 28): a backjob logged at ₱0 (a free retouch) is shown on every record as
// "<Service> (retouch/backjob)", e.g. "Hiko Deluxe (retouch/backjob)".
export const RETOUCH = " (retouch/backjob)";

export function serviceLabel(name: string | null | undefined, kind: string | null | undefined, amountCents: number | string | null | undefined): string {
  const n = name ?? "Service";
  return kind === "BACKJOB" && !Number(amountCents ?? 0) ? `${n}${RETOUCH}` : n;
}
