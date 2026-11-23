import { describe, expect, it } from "vitest";
import { isIsoDate, manilaToday } from "../../src/lib/dates";

describe("dates", () => {
  it("uses the Manila business date, not UTC", () => {
    // 2026-11-23 17:30 UTC is already 2026-11-24 01:30 in Manila.
    expect(manilaToday(new Date("2026-11-23T17:30:00Z"))).toBe("2026-11-24");
    expect(manilaToday(new Date("2026-11-23T15:59:00Z"))).toBe("2026-11-23");
  });
  it("validates real calendar dates only", () => {
    expect(isIsoDate("2024-02-29")).toBe(true);
    expect(isIsoDate("2025-02-29")).toBe(false);
    expect(isIsoDate("2025-1-01")).toBe(false);
  });
});
