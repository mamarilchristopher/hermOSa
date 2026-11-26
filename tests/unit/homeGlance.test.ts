import { describe, expect, it } from "vitest";
import { computeGlance, dayLabel, type StatusDay } from "../../src/lib/homeGlance";

const A = { id: "a", name: "QC Main" }, B = { id: "b", name: "Fairview" };
const d = (b: string, date: string, cents: number | null, mark: string | null = null, staged = false): StatusDay => [b, date, cents, mark, staged, null];

describe("computeGlance", () => {
  const days: StatusDay[] = [
    d("a", "2026-10-01", 100_00), d("a", "2026-10-02", 300_00), d("a", "2026-10-03", 999_00), d("a", "2026-10-31", 50_00),
    d("b", "2026-10-01", 200_00),
    d("a", "2026-11-01", 200_00), d("a", "2026-11-02", 400_00), d("a", "2026-11-03", 600_00), d("a", "2026-11-04", 70_00),
    d("b", "2026-11-01", null, "CLOSED"), d("b", "2026-11-02", null, "NO_SALES"),
  ];
  const g = computeGlance("2026-11-04", [A, B], days);

  it("reads yesterday per branch and compares with the month average before it", () => {
    expect(g.yesterday).toBe("2026-11-03");
    expect(g.branches[0].yesterday).toEqual({ kind: "sales", cents: 600_00 });
    expect(g.branches[0].vsAvg).toBeCloseTo(1); // 600 vs avg 300
    expect(g.branches[1].yesterday).toEqual({ kind: "empty" });
    expect(g.yesterdayMissing).toEqual(["Fairview"]);
    expect(g.yesterdayTotal).toBe(600_00);
  });

  it("compares month to date with the same days last month", () => {
    expect(g.branches[0].mtd).toBe(1200_00);
    expect(g.branches[0].lastSame).toBe(1399_00);
    expect(g.branches[1].mtd).toBe(0);
    expect(g.mtd).toBe(1200_00);
    expect(g.lastMonthTotal).toBe(1649_00);
    expect(g.todaySoFar).toBe(70_00);
  });

  it("averages Zero sales as ₱0, leaves Closed and empty days out, and lists empty days", () => {
    expect(g.branches[0].avg).toBe(400_00);
    expect(g.branches[1].avg).toBe(0);
    expect(g.branches[1].emptyDays).toEqual(["2026-11-03"]);
    expect(g.emptyDays).toBe(1);
    expect(g.pace).toBe(400_00 * 30);
  });

  it("has no complete days on the 1st", () => {
    const first = computeGlance("2026-11-01", [A], days);
    expect(first.through).toBeNull();
    expect(first.mtd).toBe(0);
    expect(first.pace).toBeNull();
    expect(first.yesterdayMissing).toEqual([]);
  });

  it("labels days", () => expect(dayLabel("2026-11-23")).toBe("Mon, Nov 23"));
});

import { cutoffEnd } from "../../src/lib/homeGlance";
describe("cutoffEnd", () => {
  it("splits the month at the 15th", () => {
    expect(cutoffEnd("2026-11-03")).toBe("2026-11-15");
    expect(cutoffEnd("2026-11-15")).toBe("2026-11-15");
    expect(cutoffEnd("2026-11-16")).toBe("2026-11-30");
    expect(cutoffEnd("2026-02-20")).toBe("2026-02-28");
  });
});

describe("service log as the source from Nov 25", () => {
  const s = (b: string, date: string, rec: number | null, service: number | null): StatusDay => [b, date, rec, null, false, service];
  const g = computeGlance("2026-11-26", [A, B], [
    s("a", "2026-11-24", null, 500_00), // before the switch: service log alone doesn't count
    s("a", "2026-11-25", null, 300_00), s("a", "2026-11-26", null, 120_00),
    s("b", "2026-11-26", 90_00, 40_00), // v0.80.1: the service log wins over typed Daily Sales from Nov 25
    s("b", "2026-11-25", 70_00, null), // typed but nothing logged: empty
  ]);
  it("uses the day's service log total, even when Daily Sales were typed", () => {
    expect(g.branches[0].todayCell).toEqual({ kind: "sales", cents: 120_00, log: true });
    expect(g.branches[0].yesterday).toEqual({ kind: "sales", cents: 300_00, log: true });
    expect(g.branches[0].mtd).toBe(300_00);
    expect(g.branches[1].todayCell).toEqual({ kind: "sales", cents: 40_00, log: true });
    expect(g.branches[1].yesterday).toEqual({ kind: "empty" });
    expect(g.todaySoFar).toBe(160_00);
  });
});
