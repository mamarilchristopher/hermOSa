import { describe, expect, it } from "vitest";
import { markDuplicates, normalizeScan, scanSystem, type RawScan } from "../../src/lib/receiptScan";

// DEMO data only (CHRIS Nov 28: use the samples' structure, never their data).
const cats = [{ id: "c-elec", name: "Electricity", grp: "FIXED" }, { id: "c-trans", name: "Transport & delivery", grp: "BUSINESS" }];
const branches = [{ id: "b-fv", code: "FAIRVIEW", name: "Fairview" }, { id: "b-mk", code: "MARIKINA", name: "Marikina" }];
const base: RawScan = { doc_type: "BILL", payee: "Demo Power Co.", paid_via: null, branch_code: "FAIRVIEW", branch_reason: "service address in Fairview", note: "", items: [] };
const today = "2026-11-28";

describe("receipt scan", () => {
  it("cleans amounts, dates, categories and the branch", () => {
    const s = normalizeScan({ ...base, items: [
      { date: "2026-11-20", amount: 1234.5, description: "  Electricity  bill, October 2026 ", category_id: "c-elec", unsure: false },
      { date: "2026-12-05", amount: 300, description: "Future date", category_id: "nope", unsure: false },
      { date: null, amount: 0, description: "zero", category_id: null, unsure: false },
      { date: "2026-02-30", amount: 99.999, description: "x", category_id: "c-trans", unsure: false },
    ] }, { cats, branches, today });
    expect(s.branch_id).toBe("b-fv");
    expect(s.items).toHaveLength(3);
    expect(s.items[0]).toMatchObject({ spent_on: "2026-11-20", amount_cents: 123450, description: "Electricity bill, October 2026", category_id: "c-elec", unsure: false });
    expect(s.items[1]).toMatchObject({ spent_on: null, category_id: null, unsure: true });
    expect(s.items[2]).toMatchObject({ spent_on: null, amount_cents: 10000, description: "Transport & delivery", unsure: true });
    expect(s.total_cents).toBe(123450 + 30000 + 10000);
  });

  it("never fills a sales invoice and drops an unknown branch", () => {
    const s = normalizeScan({ ...base, doc_type: "SALES_INVOICE", branch_code: "NOWHERE", items: [{ date: today, amount: 1500, description: "Facial", category_id: null, unsure: false }] },
      { cats, branches, today });
    expect(s.not_expense).toBe(true);
    expect(s.items).toHaveLength(0);
    expect(s.branch_id).toBeNull();
  });

  it("flags likely duplicates", () => {
    const items = normalizeScan({ ...base, items: [
      { date: "2026-11-20", amount: 250, description: "Delivery", category_id: "c-trans", unsure: false },
      { date: null, amount: 1234.5, description: "Bill", category_id: "c-elec", unsure: false },
      { date: "2026-11-01", amount: 250, description: "Delivery", category_id: "c-trans", unsure: false },
    ] }, { cats, branches, today }).items;
    const out = markDuplicates(items, [{ amount_cents: 25000, spent_on: "2026-11-21", description: "Lalamove" }, { amount_cents: 123450, spent_on: "2026-10-25", description: "Electricity" }], today);
    expect(out[0].dup?.description).toBe("Lalamove");
    expect(out[1].dup?.description).toBe("Electricity");
    expect(out[2].dup).toBeUndefined();
  });

  it("lists every category and branch for the reader", () => {
    const t = scanSystem(cats, branches);
    expect(t).toContain("c-elec: Electricity");
    expect(t).toContain("FAIRVIEW (Fairview)");
    expect(t).toContain("SALES_INVOICE");
    expect(scanSystem(cats, [{ id: "b-q", code: "MARIKINA", name: "Marikina" }])).toContain("MARIKINA (Marikina): registered name HermosaCuatro");
  });
});
