import { describe, expect, it } from "vitest";
import { buildDashboard, linesOf, type Category, type Expense } from "../../src/lib/expenses";

const B = [{ id: "qc", code: "QC_MAIN", name: "QC Main" }, { id: "fv", code: "FAIRVIEW", name: "Fairview" }];
const cat = (id: string, kind: Category["kind"], auto: Category["auto_source"] = null, budget: number | null = null): Category =>
  ({ id, name: id, grp: kind === "AUTO" ? "AUTO" : "FIXED", kind, auto_source: auto, budget_cents: budget, sort: 1, active: true });
const cats = [cat("pay", "AUTO", "PAYROLL"), cat("ads", "AUTO", "META_ADS"), cat("rent", "MONTHLY"), cat("supplies", "ONE_OFF", null, 1000)];
let n = 0;
const e = (o: Partial<Expense> & { spent_on: string; amount_cents: number }): Expense =>
  ({ id: `x${n++}`, branch_id: "qc", category_id: "rent", description: "Rent, October", payee: "DEMO Landlord", paid_via: null, receipt_paths: [], ...o });

describe("expenses dashboard", () => {
  const expenses = [
    e({ spent_on: "2026-10-05", amount_cents: 100000 }), e({ spent_on: "2026-10-07", amount_cents: 50000, branch_id: "fv" }),
    e({ spent_on: "2026-11-04", amount_cents: 110000, description: "Rent, November" }),
    e({ spent_on: "2026-11-10", amount_cents: 2000, category_id: "supplies", branch_id: null }),
    e({ spent_on: "2026-11-29", amount_cents: 999, category_id: "supplies" }), // after today: not counted yet
  ];
  const payroll = [{ run: "r1", start: "2026-11-01", end: "2026-11-15", branch_id: "qc", gross_cents: 30000, people: 2 }, { run: "r1", start: "2026-11-01", end: "2026-11-15", branch_id: "hq", gross_cents: 5000, people: 1 }];
  const ads = [{ d: "2026-11-02", branch: "FAIRVIEW", cents: 10000 }, { d: "2026-11-03", branch: "FAIRVIEW", cents: 15000 }, { d: "2026-10-01", branch: "QC_MAIN", cents: 40000, monthly: true }];

  it("lines: payroll by home branch (HQ = company-wide), ads with VAT per branch", () => {
    const l = linesOf("2026-11", "2026-11-27", cats, expenses, payroll, ads, B);
    expect(l.find((x) => x.key === "ads-fv")?.cents).toBe(28000);
    expect(l.filter((x) => x.auto === "PAYROLL").map((x) => [x.branch_id, x.cents])).toEqual(expect.arrayContaining([["qc", 30000], [null, 5000]]));
    expect(l.some((x) => x.cents === 999)).toBe(false);
  });

  it("all branches: totals, due bills, per-branch share of company-wide costs", () => {
    const d = buildDashboard({ ym: "2026-11", today: "2026-11-27", scope: null, branches: B, cats, expenses, payroll, ads,
      sales: new Map([["qc", 300000], ["fv", 100000]]), prevSales: new Map([["qc", 200000]]) });
    expect(d.spent).toBe(110000 + 2000 + 30000 + 5000 + 28000);
    expect(d.prevSpent).toBe(100000 + 50000 + 44800);
    expect(d.sales).toBe(400000);
    expect(d.due.map((x) => [x.branch_id, x.expected, x.overdue])).toEqual([["fv", 50000, true]]);
    expect(d.dueDone).toBe(1);
    const qc = d.branches.find((b) => b.id === "qc")!;
    expect(qc.spent).toBe(110000 + 30000 + Math.round(7000 * 0.75));
    expect(d.vsLabel).toBe("Oct 1–27");
  });

  it("a branch tab adds its share of company-wide costs; company-wide shows no sales", () => {
    const base = { ym: "2026-11", today: "2026-11-27", branches: B, cats, expenses, payroll, ads, sales: new Map([["qc", 300000], ["fv", 100000]]), prevSales: new Map<string, number>() };
    const fv = buildDashboard({ ...base, scope: "fv" });
    expect(fv.spent).toBe(28000 + Math.round(7000 * 0.25));
    expect(fv.sales).toBe(100000);
    const co = buildDashboard({ ...base, scope: "company" });
    expect(co.spent).toBe(7000);
    expect(co.sales).toBeNull();
  });
});
