/**
 * CHRIS Nov 26: while the old paper service logs for Nov 1–24, 2026 are typed in, keep a running check of
 * the service log totals against the declared sales already in Daily sales. Only that window: from Nov 25 the
 * service log itself is the source.
 */
export const CHECK_FROM = "2026-11-01";
export const CHECK_TO = "2026-11-24";

export const inCheckWindow = (d: string) => d >= CHECK_FROM && d <= CHECK_TO;

/** One row of daily_sales_status.days: [branch, date, declared cents, mark, staged, service log cents]. */
export type StatusDay = [string, string, number | string | null, string | null, boolean, number | string | null];

export type DayCheck = { date: string; declared: number | null; logged: number; mark: string | null; diff: number; status: "match" | "short" | "over" | "closed" | "undeclared" };
export type BranchCheck = { branch: string; declared: number; logged: number; diff: number; days: DayCheck[]; matched: number; toCheck: number };

const num = (v: number | string | null) => (v === null || v === undefined ? null : Number(v));

/** diff = logged − declared: below zero = still to log (or missing), above zero = logged more than declared. */
export function checkDay(date: string, declaredRaw: number | string | null, mark: string | null, loggedRaw: number | string | null): DayCheck {
  const logged = num(loggedRaw) ?? 0;
  const declared = num(declaredRaw) ?? (mark === "NO_SALES" ? 0 : null);
  if (declared === null) {
    if (mark === "CLOSED") return { date, declared: null, logged, mark, diff: logged, status: logged === 0 ? "closed" : "over" };
    return { date, declared: null, logged, mark, diff: logged, status: "undeclared" };
  }
  const diff = logged - declared;
  return { date, declared, logged, mark, diff, status: diff === 0 ? "match" : diff < 0 ? "short" : "over" };
}

export function checkBranches(days: StatusDay[], branchIds: string[]): BranchCheck[] {
  return branchIds.map((branch) => {
    const list = days
      .filter(([b, d]) => b === branch && inCheckWindow(d))
      .map(([, d, rec, mark, , svc]) => checkDay(d, rec, mark, svc))
      .sort((a, b) => a.date.localeCompare(b.date));
    const declared = list.reduce((s, x) => s + (x.declared ?? 0), 0);
    const logged = list.reduce((s, x) => s + x.logged, 0);
    const matched = list.filter((x) => x.status === "match" || x.status === "closed").length;
    return { branch, declared, logged, diff: logged - declared, days: list, matched, toCheck: list.length - matched };
  });
}
