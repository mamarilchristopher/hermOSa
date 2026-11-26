/** The button on a notice: some kinds get a clearer label than "Open" (update-0031). */
export function noticeButton(kind: string | null | undefined): string {
  if (kind === "COMMISSION_APPROVED") return "Check your current commission total";
  if (kind === "COMMISSION_REJECTED") return "See my commissions";
  if (kind === "DETAILS_APPROVED" || kind === "DETAILS_RETURNED") return "Open my details";
  if (kind === "LEAVE_APPROVED") return "See the schedule";
  if (kind === "LEAVE_FILED") return "Review leave";
  if (kind === "LEAVE_DECLINED") return "See my leave";
  if (kind === "SWAP_ASKED") return "Accept or decline";
  if (kind === "SWAP_TO_APPROVE") return "Review swap";
  if (kind === "PAYMENT_PROOF") return "Confirm payment";
  if (kind === "PAYMENT_RECEIVED" || kind === "PAYMENT_NOT_RECEIVED") return "Open the entry";
  return "Open";
}

// Turn a notice into a link that lands on the exact Daily Sales cells it is about (highlighted).
// Notices name the branch first ("Marikina: Nov 24 ₱9,800.00, ..." or "Marikina, Nov 24, 2026: ...") and the days as "Mon D".
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function noticeHref(link: string | null, body: string | null, branches: { code: string; name: string }[]): string | null {
  if (!link) return null;
  const m = /^\/sales\/daily\?month=(\d{4})-(\d{2})$/.exec(link);
  if (!m || !body) return link;
  const branch = [...branches].sort((a, b) => b.name.length - a.name.length).find((b) => body.startsWith(b.name));
  if (!branch) return link;
  const year = Number(m[1]), month = Number(m[2]);
  const dates = new Set<string>();
  for (const [, mon, day, y] of body.matchAll(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2})(?:, (\d{4}))?\b/g)) {
    const mi = MONTHS.indexOf(mon) + 1;
    const yy = y ? Number(y) : mi > month ? year - 1 : year;
    dates.add(`${yy}-${String(mi).padStart(2, "0")}-${day.padStart(2, "0")}`);
  }
  const inMonth = [...dates].filter((d) => d.startsWith(`${m[1]}-${m[2]}`)).sort();
  return inMonth.length ? `${link}&hl=${branch.code}:${inMonth.join(".")}` : link;
}

/** Read ?hl=CODE:2026-11-24.2026-11-23 back into "branchId|date" cell keys. */
export function highlightKeys(hl: string | undefined, branches: { id: string; code: string }[], month: string): string[] {
  const m = /^([A-Z_]{1,20}):((?:\d{4}-\d{2}-\d{2}\.?){1,40})$/.exec(hl ?? "");
  if (!m) return [];
  const b = branches.find((x) => x.code === m[1]);
  if (!b) return [];
  return m[2].split(".").filter((d) => d.startsWith(month)).map((d) => `${b.id}|${d}`);
}
