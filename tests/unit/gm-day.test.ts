import { describe, expect, it } from "vitest";
import { cutoffInfo, daySections, paydayNear, staffCheckins, type DayCounts } from "../../src/lib/gmDay";

const base: DayCounts = { bookingsToday: 5, followups: 0, promoDue: 0, picks: 3, drafts: 0, liveNoBuyers: [], missingToday: 0, missingYesterday: 0, pendingSignoff: 0, pendingPayments: 0, behind: null, needPerDay: null };

describe("My day", () => {
  it("knows when payday is near", () => {
    expect(cutoffInfo("2026-11-13")).toEqual({ end: "2026-11-15", daysLeft: 2 });
    expect(paydayNear("2026-11-12")).toBe(true);
    expect(paydayNear("2026-11-10")).toBe(false);
    expect(cutoffInfo("2026-11-28").daysLeft).toBe(2);
    expect(paydayNear("2026-02-26")).toBe(true);
  });
  it("suggests a check-in for frequent lates or backjobs", () => {
    const people = [{ id: "a", name: "Demo Ana" }, { id: "b", name: "Demo Bea" }, { id: "c", name: "Demo Cy" }];
    const lates = [1, 2, 3].map(() => ({ employee_id: "a", late_minutes: 10 }));
    const flags = staffCheckins(people, lates, [{ performer_id: "b" }, { performer_id: "b" }, { performer_id: "c" }]);
    expect(flags.map((f) => f.id).sort()).toEqual(["a", "b"]);
    expect(flags.find((f) => f.id === "a")!.why).toBe("late 3× (30 min)");
  });
  it("shows counts and calls out what needs attention", () => {
    const s = daySections({ ...base, followups: 4, missingYesterday: 1, drafts: 2 }, { payday: false, weak: false, weekdayName: "Tue" });
    const all = Object.fromEntries(s.flatMap((x) => x.items).map((i) => [i.key, i]));
    expect(all.followups.count).toBe(4);
    expect(all.followups.tone).toBe("todo");
    expect(all.sales.tone).toBe("warn");
    expect(all.propose.note).toContain("2 drafts");
  });
});
