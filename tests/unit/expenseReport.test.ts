import { describe, expect, it } from "vitest";
import type { Category, Expense } from "../../src/lib/expenses";
import { buildReport, linesBetween, periodOf, rangeLabel, reportCsv } from "../../src/lib/expenseReport";

// DEMO data only.
const B = [{ id: "qc", code: "QC_MAIN", name: "QC Main" }, { id: "fv", code: "FAIRVIEW", name: "Fairview" }];
const cat = (id: string, grp: string, kind: Category["kind"], auto: Category["auto_source"] = null): Category =>
  ({ id, name: id, grp, kind, auto_source: auto, budget_cents: null, sort: 1, active: true });
const cats = [cat("pay", "AUTO", "AUTO", "PAYROLL"), cat("ads", "AUTO", "AUTO", "META_ADS"), cat("rent", "FIXED", "MONTHLY"), cat("threads", "CLINIC", "ONE_OFF")];
let n = 0;
const e = (o: Partial<Expense> & { spent_on: string; amount_cents: number }): Expense =>
  ({ id: `x${n++}`, branch_id: "qc", category_id: "rent", description: "DEMO", payee: null, paid_via: null, receipt_paths: [], ...o });

describe("report periods", () => {
  it("month still running compares with the same days of last month", () => {
    const p = periodOf({}, "2026-11-28");
    expect([p.kind, p.at, p.from, p.upTo, p.partial, p.prevFrom, p.prevTo, p.prevLabel, p.nextAt]).toEqual(["month", "2026-11", "2026-11-01", "2026-11-28", true, "2026-10-01", "2026-10-28", "Oct 1–28, 2026", null]);
    const done = periodOf({ at: "2026-10" }, "2026-11-28");
    expect([done.to, done.upTo, done.partial, done.prevTo, done.prevLabel, done.nextAt]).toEqual(["2026-10-31", "2026-10-31", false, "2026-09-30", "September 2026", "2026-11"]);
  });
  it("cutoffs, quarters and years step back across boundaries", () => {
    const c = periodOf({ period: "cutoff", at: "2026-01-1" }, "2026-11-28");
    expect([c.from, c.to, c.label, c.prevAt, c.prevFrom, c.prevTo]).toEqual(["2026-01-01", "2026-01-15", "Jan 1–15, 2026 cutoff", "2025-12-2", "2025-12-16", "2025-12-31"]);
    const q = periodOf({ period: "quarter", at: "2026-Q1" }, "2026-11-28");
    expect([q.from, q.to, q.prevAt, q.prevFrom, q.prevTo, q.nextAt]).toEqual(["2026-01-01", "2026-03-31", "2025-Q4", "2025-10-01", "2025-12-31", "2026-Q2"]);
    const y = periodOf({ period: "year" }, "2026-11-28");
    expect([y.from, y.upTo, y.prevFrom, y.prevTo]).toEqual(["2026-01-01", "2026-11-28", "2025-01-01", "2025-11-28"]);
  });
  it("bad or future keys fall back to the current period; custom ranges are cleaned", () => {
    expect(periodOf({ at: "2027-05" }, "2026-11-28").at).toBe("2026-11");
    expect(periodOf({ period: "cutoff", at: "nope" }, "2026-11-28").at).toBe("2026-11-2");
    const c = periodOf({ period: "custom", from: "2026-11-20", to: "2026-11-10" }, "2026-11-28");
    expect([c.from, c.to, c.prevFrom, c.prevTo]).toEqual(["2026-11-10", "2026-11-20", "2026-10-30", "2026-11-09"]);
    expect(periodOf({ period: "custom", from: "2026-11-01", to: "2027-01-01" }, "2026-11-28").to).toBe("2026-11-28");
    expect(rangeLabel("2025-12-30", "2026-01-02")).toBe("Dec 30, 2025 – Jan 2, 2026");
  });
});

describe("report figures", () => {
  const expenses = [
    e({ spent_on: "2026-09-20", amount_cents: 80000 }),
    e({ spent_on: "2026-10-05", amount_cents: 100000, receipt_paths: ["r.jpg"] }),
    e({ spent_on: "2026-11-05", amount_cents: 110000, receipt_paths: ["r2.jpg"] }),
    e({ spent_on: "2026-11-09", amount_cents: 40000, category_id: "threads", branch_id: "fv" }),
    e({ spent_on: "2026-11-12", amount_cents: 20000, category_id: "threads", branch_id: null }),
  ];
  const payroll = [{ run: "r1", start: "2026-10-16", end: "2026-10-31", branch_id: "qc", gross_cents: 30000, people: 2 },
    { run: "r2", start: "2026-11-01", end: "2026-11-15", branch_id: "fv", gross_cents: 50000, people: 2 }];
  const ads = [{ d: "2026-10-30", branch: "QC_MAIN", cents: 10000 }, { d: "2026-11-02", branch: "QC_MAIN", cents: 10000 }, { d: "2026-11-03", branch: "FAIRVIEW", cents: 5000 }];

  it("a range across months keeps one ad line per branch per month", () => {
    const l = linesBetween("2026-10-16", "2026-11-15", cats, expenses, payroll, ads, B);
    expect(l.filter((x) => x.auto === "META_ADS").map((x) => [x.date, x.branch_id, x.cents])).toEqual(expect.arrayContaining([["2026-10-30", "qc", 11200], ["2026-11-02", "qc", 11200], ["2026-11-03", "fv", 5600]]));
    expect(l.some((x) => x.date === "2026-10-05")).toBe(false);
    expect(l.filter((x) => x.auto === "PAYROLL")).toHaveLength(2);
  });

  it("all branches: groups, totals, branch split adds up", () => {
    const period = periodOf({ at: "2026-11" }, "2026-11-30");
    const r = buildReport({ period, scope: null, branches: B, cats, expenses, payroll, ads,
      sales: new Map([["qc", 300000], ["fv", 100001]]), prevSales: new Map([["qc", 250000]]) });
    expect(r.spent).toBe(110000 + 40000 + 20000 + 50000 + 11200 + 5600);
    expect(r.prevSpent).toBe(100000 + 30000 + 11200);
    expect(r.groups.map((g) => g.label)).toEqual(["People", "Marketing", "Fixed costs", "Clinic"]);
    expect(r.groups.find((g) => g.key === "MARKETING")!.rows[0].name).toBe("ads*");
    expect(r.branches!.reduce((s, b) => s + b.shared, 0)).toBe(20000);
    expect(r.branches!.reduce((s, b) => s + b.left, 0)).toBe(r.left);
    expect([r.entries, r.receipts, r.hasAds]).toEqual([3, 1, true]);
  });

  it("one branch gets its share of company-wide costs; company-wide has no sales", () => {
    const period = periodOf({ at: "2026-11" }, "2026-11-30");
    const base = { period, branches: B, cats, expenses, payroll, ads, sales: new Map([["qc", 300000], ["fv", 100000]]), prevSales: new Map<string, number>() };
    const fv = buildReport({ ...base, scope: "fv" });
    expect(fv.spent).toBe(40000 + 50000 + 5600 + 5000);
    expect(fv.groups.at(-1)!.label).toBe("Shared");
    const co = buildReport({ ...base, scope: "company" });
    expect([co.sales, co.spent, co.branches]).toEqual([null, 20000, null]);
  });

  it("Excel file starts with a BOM and quotes commas", () => {
    const period = periodOf({ at: "2026-11" }, "2026-11-30");
    const r = buildReport({ period, scope: null, branches: B, cats, expenses, payroll, ads, sales: new Map(), prevSales: new Map() });
    const csv = reportCsv(r, "Expense report · November 2026", "All branches", "October 2026");
    expect(csv.startsWith("﻿Expense report")).toBe(true);
    expect(csv).toContain("Total expenses,2368.00,1412.00");
    expect(csv).toContain("* Meta ad spend includes 12% VAT");
  });
});
