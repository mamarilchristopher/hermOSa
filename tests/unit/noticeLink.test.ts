import { describe, expect, it } from "vitest";
import { highlightKeys, noticeHref } from "../../src/lib/noticeLink";

const B = [{ id: "m", code: "MARIKINA", name: "Marikina" }, { id: "s", code: "STA_MARIA", name: "Sta. Maria Bulacan" }];
describe("noticeHref", () => {
  it("adds the branch and days to Daily Sales links", () => {
    expect(noticeHref("/sales/daily?month=2026-11", "Marikina: Nov 24 ₱9,800.00, Nov 23 ₱3,200.00. By DEMO.", B))
      .toBe("/sales/daily?month=2026-11&hl=MARIKINA:2026-11-23.2026-11-24");
    expect(noticeHref("/sales/daily?month=2026-11", "Sta. Maria Bulacan, Nov 4, 2026: ₱1.00 → ₱0.00. Reason: x.", B))
      .toBe("/sales/daily?month=2026-11&hl=STA_MARIA:2026-11-04");
  });
  it("leaves other links alone", () => {
    expect(noticeHref("/services?date=2026-11-02", "Marikina: Nov 2", B)).toBe("/services?date=2026-11-02");
    expect(noticeHref(null, "x", B)).toBeNull();
  });
  it("reads highlights back as cell keys", () => {
    expect(highlightKeys("MARIKINA:2026-11-23.2026-11-24", B, "2026-11")).toEqual(["m|2026-11-23", "m|2026-11-24"]);
    expect(highlightKeys("NOPE:2026-11-23", B, "2026-11")).toEqual([]);
    expect(highlightKeys("<script>", B, "2026-11")).toEqual([]);
  });
});
