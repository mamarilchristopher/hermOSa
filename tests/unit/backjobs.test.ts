import { describe, expect, it } from "vitest";
import { clientKey, rate, tally, topReason, type BackjobRow } from "../../src/lib/backjobs";

const r = (id: string, client: string, staff: string | null, reason: string | null, date = "2026-11-20"): BackjobRow => ({ id, date, client, serviceId: "hiko", staffId: staff, reason });
describe("backjob tracking", () => {
  it("treats the same name as the same client", () => {
    expect(clientKey("  Demo  Maria ")).toBe(clientKey("demo maria"));
  });
  it("tallies per staff with the top reason", () => {
    const rows = [r("1", "Demo A", "s1", "THREAD"), r("2", "Demo B", "s1", "THREAD"), r("3", "Demo C", "s1", "UNEVEN"), r("4", "Demo D", "s2", null)];
    const t = tally(rows, (x) => x.staffId);
    expect(t[0]).toMatchObject({ key: "s1", count: 3 });
    expect(topReason(t[0])).toBe("Thread showing or loose");
    expect(topReason(t[1])).toBe("");
  });
  it("finds repeat clients", () => {
    const rows = [r("1", "Demo Maria", "s1", null), r("2", "demo maria", "s2", null), r("3", "Demo Joy", "s1", null)];
    expect(tally(rows, (x) => clientKey(x.client)).filter((t) => t.count >= 2).map((t) => t.key)).toEqual(["demo maria"]);
  });
  it("needs 5 treatments before a rate", () => {
    expect(rate(1, 4)).toBeNull();
    expect(rate(1, 10)).toBe(0.1);
  });
});
