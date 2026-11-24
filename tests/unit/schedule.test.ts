import { describe, expect, it } from "vitest";
import { branchShort, mondayOf, timeLabel, weekDates, weekLabel } from "../../src/lib/schedule";

describe("schedule helpers", () => {
  it("finds the Monday of a week", () => {
    expect(mondayOf("2026-11-25")).toBe("2026-11-23");
    expect(mondayOf("2026-11-23")).toBe("2026-11-23");
    expect(mondayOf("2026-11-29")).toBe("2026-11-23");
    expect(weekDates("2026-11-30")[6]).toBe("2026-12-06");
    expect(weekLabel("2026-11-30")).toBe("Nov 30 – Dec 6");
  });
  it("labels times and branches", () => {
    expect(timeLabel("10:00:00")).toBe("10 AM");
    expect(timeLabel("19:00")).toBe("7 PM");
    expect(timeLabel("12:30")).toBe("12:30 PM");
    expect(branchShort("Quezon City Main (Sikatuna)")).toBe("QC Main");
    expect(branchShort("Sta. Maria Bulacan")).toBe("Sta. Maria");
  });
});

import { shortNames } from "../../src/lib/schedule";
describe("short names", () => {
  it("uses first names and adds a last initial only when two share one", () => {
    expect(shortNames([{ id: "a", name: "Ana Cruz" }, { id: "b", name: "Bea Reyes" }, { id: "c", name: "Ana Lopez" }]))
      .toEqual({ a: "Ana C.", b: "Bea", c: "Ana L." });
  });
});
