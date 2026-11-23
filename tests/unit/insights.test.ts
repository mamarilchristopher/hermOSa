import { describe, expect, it } from "vitest";
import { addMonths, change, computeInsights, dateRuns, fetchStart, previousWindow, resolvePeriod, type DayRow } from "../../src/lib/insights";

const A = "a", B = "b";
const branches = [
  { id: A, code: "QC_MAIN", name: "QC Main", first_date: "2025-01-01" },
  { id: B, code: "FAIRVIEW", name: "Fairview", first_date: "2026-11-10" },
];

describe("periods", () => {
  it("defaults to this month to date", () => {
    expect(resolvePeriod(undefined, undefined, undefined, "2026-11-23")).toMatchObject({ key: "month", start: "2026-11-01", end: "2026-11-23" });
  });
  it("last month, YTD, 12 months, custom capped at today", () => {
    expect(resolvePeriod("lastmonth", undefined, undefined, "2026-03-31")).toMatchObject({ start: "2026-02-01", end: "2026-02-28" });
    expect(resolvePeriod("ytd", undefined, undefined, "2026-11-23")).toMatchObject({ start: "2026-01-01", end: "2026-11-23" });
    expect(resolvePeriod("12m", undefined, undefined, "2026-11-23")).toMatchObject({ start: "2025-11-24", end: "2026-11-23" });
    expect(resolvePeriod("custom", "2026-10-01", "2027-01-01", "2026-11-23")).toMatchObject({ start: "2026-10-01", end: "2026-11-23" });
    expect(resolvePeriod("custom", "2026-10-05", "2026-10-01", "2026-11-23").key).toBe("month");
  });
  it("month arithmetic clamps", () => {
    expect(addMonths("2026-03-31", -1)).toBe("2026-02-28");
    expect(addMonths("2024-02-29", -12)).toBe("2023-02-28");
    expect(addMonths("2026-01-15", -2)).toBe("2025-11-15");
  });
  it("comparison windows", () => {
    expect(previousWindow({ key: "month", start: "2026-11-01", end: "2026-11-22" })).toMatchObject({ start: "2026-10-01", end: "2026-10-22" });
    expect(previousWindow({ key: "custom", start: "2026-11-11", end: "2026-11-20" })).toMatchObject({ start: "2026-11-01", end: "2026-11-10" });
    expect(fetchStart(resolvePeriod(undefined, undefined, undefined, "2026-11-23"))).toBe("2025-01-01");
  });
});

describe("computeInsights", () => {
  const days: DayRow[] = [
    [A, "2025-11-01", 1000], [A, "2025-11-02", 1000], // last year, same days
    [A, "2026-10-01", 500], [A, "2026-10-02", 500], // last month, same days
    [A, "2026-11-01", 2000], [A, "2026-11-02", 3000], [A, "2026-11-23", 99999], // today not counted
    [B, "2026-11-10", 700],
  ];
  const ins = computeInsights({
    period: resolvePeriod(undefined, undefined, undefined, "2026-11-23"),
    today: "2026-11-23",
    branches,
    days,
    closed: [[A, "2026-11-03", "CLOSED", "CONFIRMED", "m1", "Owner", false], [A, "2026-11-04", "NO_SALES", "PENDING", "m2", "Owner", false]],
  });

  it("totals stop at yesterday and compare like for like", () => {
    expect(ins.compareEnd).toBe("2026-11-22");
    expect(ins.company.total).toBe(5700);
    expect(ins.company.prev).toBe(1000);
    expect(ins.company.lastYear).toBe(2000);
    expect(change(ins.company.total, ins.company.prev)).toBeCloseTo(4.7);
    expect(ins.company.best).toEqual({ date: "2026-11-02", cents: 3000 });
  });

  it("missing days skip confirmed closed days and days before a branch's first record", () => {
    const qc = ins.branches.find((b) => b.branch.id === A)!;
    const fv = ins.branches.find((b) => b.branch.id === B)!;
    expect(qc.missing).toHaveLength(22 - 2 - 1); // Nov 1-22, minus 2 sales days, minus 1 closed
    expect(qc.closedDays).toBe(1);
    expect(qc.pendingMarks).toBe(1); // a single-person mark still counts as missing
    expect(qc.missing).toContain("2026-11-04");
    expect(fv.missing).toHaveLength(12); // Nov 10-22 minus the one sales day
    expect(ins.company.missing).toHaveLength(19 + 12);
    expect(fv.share).toBeCloseTo(700 / 5700);
  });

  it("13 months of trend with the current month partial", () => {
    expect(ins.company.months).toHaveLength(13);
    expect(ins.company.months[12]).toEqual({ ym: "2026-11", cents: 5700, partial: true });
    expect(ins.company.months[0]).toEqual({ ym: "2025-11", cents: 2000, partial: false });
  });

  it("no comparison data gives null, never zero", () => {
    const fv = ins.branches.find((b) => b.branch.id === B)!;
    expect(fv.lastYear).toBeNull();
    expect(change(fv.total, fv.lastYear)).toBeNull();
  });
});

it("dateRuns groups consecutive days", () => {
  expect(dateRuns(["2024-01-03", "2024-01-01", "2024-01-02", "2024-02-01"])).toEqual([
    { from: "2024-01-01", to: "2024-01-03", days: 3 },
    { from: "2024-02-01", to: "2024-02-01", days: 1 },
  ]);
});

it("sortBranches uses the owner's order", async () => {
  const { sortBranches } = await import("../../src/lib/insights");
  const list = ["MARIKINA", "STA_MARIA", "QC_MAIN", "FAIRVIEW"].map((code) => ({ code, name: code }));
  expect(sortBranches(list).map((b) => b.code)).toEqual(["QC_MAIN", "FAIRVIEW", "STA_MARIA", "MARIKINA"]);
});

it("commission preview: 5%, lead 60 / assist 40, rounding gives the remainder to the assistant", async () => {
  const { previewCommission } = await import("../../src/lib/commission");
  expect(previewCommission(1_000_000, "LEAD")).toEqual({ total: 50000, lead: 30000, assist: 20000, solo: 0 });
  expect(previewCommission(333_300, "ASSIST")).toEqual({ total: 16665, lead: 9999, assist: 6666, solo: 0 });
  expect(previewCommission(600_000, "SOLO").solo).toBe(30000);
  expect(previewCommission(600_000, "NONCOMMI").total).toBe(0);
});
