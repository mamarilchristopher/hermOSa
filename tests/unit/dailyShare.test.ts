import { describe, expect, it } from "vitest";
import { dailyShareText, type ShareCell } from "../../src/lib/dailyShare";

const branches = [{ id: "a", name: "QC Main" }, { id: "b", name: "Fairview" }, { id: "c", name: "Sta. Maria Bulacan" }, { id: "d", name: "Marikina" }];
const cells: Record<string, ShareCell> = {
  "a|2026-11-23": { cents: 1000000, mark: null, staged: false },
  "a|2026-11-24": { cents: 4520000, mark: null, staged: false },
  "b|2026-11-24": { cents: null, mark: "NO_SALES", staged: false },
  "c|2026-11-24": { cents: null, mark: "CLOSED", staged: false },
};

describe("dailyShareText", () => {
  it("lists each branch in order with totals, month to date and average", () => {
    const t = dailyShareText("2026-11-24", branches, ["2026-11-22", "2026-11-23", "2026-11-24"], (b, d) => cells[`${b}|${d}`]);
    expect(t).toContain("Hermosa Daily Sales, Tue, Nov 24, 2026");
    expect(t).toContain("QC Main: ₱45,200\nFairview: Zero sales\nSta. Maria Bulacan: Closed\nMarikina: not entered yet");
    expect(t).toContain("Day total: ₱45,200 (1 branch not in yet)");
    expect(t).toContain("Nov to date: ₱55,200");
    expect(t).toContain("Daily average (Nov): ₱27,600");
  });
});
