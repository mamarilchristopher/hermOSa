import { describe, expect, it } from "vitest";
import { checkBranches, checkDay, inCheckWindow, type StatusDay } from "../../src/lib/declaredCheck";

describe("declared sales check (Nov 1–24, 2026)", () => {
  it("only covers Nov 1 to Nov 24", () => {
    expect(inCheckWindow("2026-10-31")).toBe(false);
    expect(inCheckWindow("2026-11-01")).toBe(true);
    expect(inCheckWindow("2026-11-24")).toBe(true);
    expect(inCheckWindow("2026-11-25")).toBe(false);
  });

  it("compares a day's service log total with its declared sales", () => {
    expect(checkDay("2026-11-02", 500000, null, 500000).status).toBe("match");
    expect(checkDay("2026-11-02", "500000", null, 300000)).toMatchObject({ status: "short", diff: -200000 });
    expect(checkDay("2026-11-02", 500000, null, 600000)).toMatchObject({ status: "over", diff: 100000 });
    expect(checkDay("2026-11-02", null, "NO_SALES", null)).toMatchObject({ status: "match", declared: 0, logged: 0 });
    expect(checkDay("2026-11-02", null, "CLOSED", null).status).toBe("closed");
    expect(checkDay("2026-11-02", null, "CLOSED", 1000).status).toBe("over");
    expect(checkDay("2026-11-02", null, null, 1000).status).toBe("undeclared");
  });

  it("totals each branch inside the window only", () => {
    const days: StatusDay[] = [
      ["A", "2026-10-31", 999, null, false, 0],
      ["A", "2026-11-01", 1000, null, false, 1000],
      ["A", "2026-11-02", 2000, null, false, 500],
      ["A", "2026-11-25", 3000, null, false, 0],
      ["B", "2026-11-01", null, "CLOSED", false, null],
    ];
    const [a, b] = checkBranches(days, ["A", "B"]);
    expect(a).toMatchObject({ declared: 3000, logged: 1500, diff: -1500, matched: 1, toCheck: 1 });
    expect(a.days.map((d) => d.date)).toEqual(["2026-11-01", "2026-11-02"]);
    expect(b).toMatchObject({ declared: 0, logged: 0, matched: 1, toCheck: 0 });
  });
});
