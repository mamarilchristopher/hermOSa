import { describe, expect, it } from "vitest";
import { announceText, installmentPlans, payLine, payStatus, payToUnlock, planDues, postingCalendar, pricingText, sessionsUnlocked } from "../../src/lib/promoPay";

const lux = [{ service_id: "x", name: "Lux Queen Single Session", unit: 150000, paid: 10, free: 3 }];

describe("installments", () => {
  it("recommends plans by price", () => {
    expect(installmentPlans(899900)).toMatchObject({ allowed: [], recommended: null });
    expect(installmentPlans(1899900)).toMatchObject({ allowed: [2, 3], recommended: 3 });
    expect(installmentPlans(4499900)).toMatchObject({ allowed: [2, 3, 4, 6], recommended: 6 });
  });
  it("splits in whole pesos, extra on the first, monthly", () => {
    expect(planDues(1899900, 3, "2026-11-27")).toEqual([
      { k: 1, due: "2026-11-27", amount: 633300 }, { k: 2, due: "2026-12-27", amount: 633300 }, { k: 3, due: "2027-01-27", amount: 633300 }]);
    expect(planDues(1000000, 3, "2026-01-31").map((d) => d.amount)).toEqual([333400, 333300, 333300]);
  });
  it("sessions follow payments, like the database", () => {
    expect(sessionsUnlocked(6, 500000, 1500000)).toBe(2);
    expect(sessionsUnlocked(6, 1500000, 1500000)).toBe(6);
    expect(payToUnlock(6, 2, 500000, 1500000)).toBe(250000);
  });
  it("knows the next payment and when a client is behind", () => {
    const s = payStatus(1500000, 3, "2026-10-01", 500000, "2026-11-15");
    expect(s.next).toMatchObject({ k: 2, due: "2026-11-01", amount: 500000 });
    expect(s).toMatchObject({ late: true, behind: 500000, balance: 1000000 });
    expect(payStatus(1500000, 3, "2026-10-01", 1500000, "2026-11-15")).toMatchObject({ next: null, late: false });
  });
  it("says the payment line in client words", () => {
    expect(payLine(1899900, "INSTALLMENT", 3)).toBe("₱18,999 in full, or 3 monthly payments of ₱6,333");
    expect(payLine(1899900, "FULL", null)).toBe("₱18,999 in full");
  });
});

describe("posting calendar", () => {
  it("launch, reminder, last 3 days and last day", () => {
    expect(postingCalendar("2026-11-27", "2026-12-10").map((r) => [r.slot, r.due_on, r.feed])).toEqual([
      ["LAUNCH", "2026-11-27", true], ["REMINDER", "2026-12-03", false], ["LAST_DAYS", "2026-12-08", false], ["LAST_DAY", "2026-12-10", false]]);
    expect(postingCalendar("2026-11-27", null).map((r) => r.slot)).toEqual(["LAUNCH", "REMINDER"]);
    expect(postingCalendar("2026-11-27", "2026-11-29").map((r) => r.slot)).toEqual(["LAUNCH", "LAST_DAY"]);
  });
});

describe("texts", () => {
  const p = { title: "The Christmas Glow-Up", items: lux, price: 1899900, months: 3, endsOn: "2026-12-10", pay: "INSTALLMENT" as const, maxPayments: 3 };
  it("pricing card uses client names and never a regular price", () => {
    const t = pricingText(p);
    expect(t).toContain("our best-selling Lux Queen Drip");
    expect(t).toContain("3 monthly payments");
    expect(t).not.toMatch(/regular|single session/i);
  });
  it("announcement says how to log it", () => {
    const t = announceText({ ...p, serviceLog: "pick it" });
    expect(t).toContain("📣 NEW PROMO: The Christmas Glow-Up");
    expect(t).toContain("10 + 3 FREE Lux Queen Drip");
    expect(t).toContain("Service log: pick it");
  });
});
