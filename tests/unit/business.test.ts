import { describe, expect, it } from "vitest";
import { bookingPatterns, companyDays, dayContext, monthlyTotals, promoPicks, serviceFamily, serviceMix, staffPatterns, weekdayAverages, weekStart, weeklyTotals } from "../../src/lib/business";
import type { StatusDay } from "../../src/lib/homeGlance";
import type { Suggestion } from "../../src/lib/promoRules";

const day = (b: string, d: string, c: number | null, mark: string | null = null): StatusDay => [b, d, c, mark, false, null];

describe("business dashboard math", () => {
  it("adds branches per day and keeps zero-sales days", () => {
    const m = companyDays([day("a", "2026-11-20", 1000), day("b", "2026-11-20", 500), day("a", "2026-11-21", null, "NO_SALES"), day("a", "2026-11-22", null, "CLOSED"), day("x", "2026-11-20", 9)], ["a", "b"]);
    expect(m.get("2026-11-20")).toBe(1500);
    expect(m.get("2026-11-21")).toBe(0);
    expect(m.get("2026-11-22")).toBeNull();
  });
  it("weeks start on Monday and the current week is partial", () => {
    expect(weekStart("2026-11-26")).toBe("2026-11-23"); // Thursday → Monday
    expect(weekStart("2026-11-29")).toBe("2026-11-23"); // Sunday stays in the same week
    const w = weeklyTotals(new Map([["2026-11-23", 100], ["2026-11-22", 50]]), "2026-11-26", 2);
    expect(w).toEqual([{ start: "2026-11-16", cents: 50, partial: false }, { start: "2026-11-23", cents: 100, partial: true }]);
  });
  it("months run back from this month", () => {
    const m = monthlyTotals(new Map([["2026-01-05", 7], ["2025-12-31", 3]]), "2026-01-10", 2);
    expect(m).toEqual([{ ym: "2025-12", cents: 3, partial: false }, { ym: "2026-01", cents: 7, partial: true }]);
  });
  it("weekday averages skip days without figures", () => {
    const wk = weekdayAverages(new Map([["2026-11-23", 100], ["2026-11-16", 300], ["2026-11-24", null]]), "2026-11-26", 2);
    expect(wk[0]).toEqual({ day: 1, avg: 200 });
    expect(wk[1]).toEqual({ day: 2, avg: null });
  });
  it("groups packages with their single sessions", () => {
    expect(serviceFamily("Brilliant 10+3")).toBe("Brilliant");
    expect(serviceFamily("Brilliant Single Session")).toBe("Brilliant");
    expect(serviceFamily("Brilliant · Glow Year")).toBe("Brilliant");
    const log = (d: string, s: string, c: number) => ({ id: d + s, branch_id: "a", service_date: d, service_id: s, amount_paid_cents: c, performer_id: "p", assistant_id: null, commission_type: "PAID" });
    const mix = serviceMix([log("2026-11-25", "h", 900), log("2026-11-20", "b", 100), log("2026-10-20", "b", 50)], { h: "Hiko Deluxe", b: "Brilliant 10+3" }, "2026-11-26");
    expect(mix.total).toBe(1000);
    expect(mix.hiko).toBe(900);
    expect(mix.list.find((x) => x.name === "Brilliant")).toMatchObject({ cents: 100, prevCents: 50 });
  });
  it("counts lead, assist, commission and lates per person", () => {
    const s = staffPatterns(
      [{ id: "1", branch_id: "a", service_date: "2026-11-25", service_id: "h", amount_paid_cents: 1000, performer_id: "p", assistant_id: "q", commission_type: "PAID" }],
      [{ employee_id: "p", amount_cents: 30 }, { employee_id: "q", amount_cents: 20 }], [{ employee_id: "r", late_minutes: 12 }],
      [{ id: "p", name: "Demo A", branch: "QC" }, { id: "q", name: "Demo B", branch: "QC" }, { id: "r", name: "Demo C", branch: "QC" }, { id: "z", name: "Idle", branch: "QC" }], "2026-10-30");
    expect(s.map((x) => x.id)).toEqual(["p", "q", "r"]);
    expect(s[0]).toMatchObject({ lead: 1, sales: 1000, commission: 30 });
    expect(s[1]).toMatchObject({ assist: 1, commission: 20 });
    expect(s[2]).toMatchObject({ lates: 1, lateMin: 12 });
  });
  it("show-up rate leaves out cancelled and future bookings", () => {
    const b = (status: string, appt: string) => ({ csr_employee_id: "c", booked_on: "2026-11-20", appointment_date: appt, status, branch_id: "a" });
    const r = bookingPatterns([b("DONE", "2026-11-21"), b("UNRESPONSIVE", "2026-11-22"), b("CANCELLED", "2026-11-22"), b("BOOKED", "2026-11-30")], { c: "Demo CSR" }, "2026-10-30", "2026-11-26");
    expect(r.past).toBe(2);
    expect(r.showRate).toBe(0.5);
    expect(r.csrs[0]).toMatchObject({ name: "Demo CSR", made: 4, past: 2, showed: 1 });
  });
  it("payday puts programs first; a slow day puts easy bundles first", () => {
    const wk = [1, 2, 3, 4, 5, 6, 0].map((d) => ({ day: d, avg: d === 1 ? 50 : 100 }));
    const idea = (kind: Suggestion["kind"]): Suggestion => ({ id: kind, kind, why: "", title: kind, tagline: "", items: [], price: 1, months: 1 });
    const ideas = [idea("SLOW"), idea("SEASON"), idea("PROGRAM")];
    const pay = dayContext("2026-11-30", wk, { mtd: 0, lastMonthTotal: 0, worst: null, monthEnd: "2026-11-30" }); // Monday, month end
    expect(pay.payday).toBe(true);
    expect(promoPicks(ideas, pay)[0].idea.kind).toBe("PROGRAM");
    const slow = dayContext("2026-11-23", wk, { mtd: 100, lastMonthTotal: 900, worst: { name: "Demo", change: -0.2 }, monthEnd: "2026-11-30" }); // Monday the 23rd
    expect(slow).toMatchObject({ payday: false, weak: true, daysLeft: 8, needPerDay: 100, behind: { name: "Demo" } });
    expect(promoPicks(ideas, slow).map((x) => x.idea.kind)).toEqual(["SEASON", "SLOW", "PROGRAM"]);
  });
});
