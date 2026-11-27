// update-0100 (CHRIS Nov 28): Business › Expenses. DEMO fixtures only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, gm: Person, staff: Person, finance: Person, branchMgr: Person;
let rent: string, supplies: string, payrollCat: string, org: string;

beforeAll(async () => {
  db = await TestDb.create();
  owner = await db.person("Owner", [["OWNER", null]]);
  gm = await db.person("General Manager", [["MANAGER", null]]);
  staff = await db.person("Fairview Staff", [["CLINICIAN", "FAIRVIEW"]]);
  finance = await db.person("Finance", [["FINANCE", null]]);
  branchMgr = await db.person("Branch Manager", [["MANAGER", "FAIRVIEW"]]);
  await db.sql("SELECT private.seed_expense_categories()");
  const cats = (await db.sql("SELECT id, name FROM public.expense_categories")).rows;
  rent = cats.find((c) => c.name === "Rent")!.id;
  supplies = cats.find((c) => c.name === "Medical supplies & threads")!.id;
  payrollCat = cats.find((c) => c.name === "Salaries & commissions")!.id;
  org = (await db.sql("SELECT id FROM public.organizations LIMIT 1")).rows[0].id;
}, 60_000);
afterAll(async () => db?.close());

const exp = (o: Record<string, unknown> = {}) => JSON.stringify({ branch_id: db.branches.FAIRVIEW, category_id: rent, spent_on: "2026-11-05", amount_cents: 6000000, description: "Rent, November", payee: "DEMO Landlord", paid_via: "BANK", ...o });

describe("expenses", () => {
  it("starts with the category list, auto ones marked", async () => {
    const { rows } = await db.sql("SELECT count(*)::int n, count(*) FILTER (WHERE kind = 'AUTO')::int a FROM public.expense_categories");
    expect(rows[0].n).toBeGreaterThan(25);
    expect(rows[0].a).toBe(2);
  });

  it("owners, the GM and finance add expenses; clinic staff and branch managers can't", async () => {
    expect(await db.rpc(owner, "aal2", "save_expense", [exp()])).toMatchObject({ ok: true });
    expect(await db.rpc(gm, "aal1", "save_expense", [exp({ category_id: supplies, branch_id: null, amount_cents: 360000, description: "DEMO threads" })])).toMatchObject({ ok: true });
    expect(await db.rpc(finance, "aal2", "save_expense", [exp({ amount_cents: 100 })])).toMatchObject({ ok: true });
    expect(await db.rpc(staff, "aal1", "save_expense", [exp()])).toMatchObject({ ok: false, error: "FORBIDDEN" });
    expect(await db.rpc(branchMgr, "aal1", "save_expense", [exp()])).toMatchObject({ ok: false, error: "FORBIDDEN" });
  });

  it("rejects bad input and the automatic categories", async () => {
    for (const [bad, err] of [[exp({ amount_cents: 0 }), "BAD_AMOUNT"], [exp({ category_id: payrollCat }), "BAD_CATEGORY"], [exp({ spent_on: "2019-01-01" }), "BAD_DATE"],
      [exp({ description: "x" }), "BAD_REQUEST"], [exp({ paid_via: "CHEQUE" }), "BAD_REQUEST"], [exp({ receipts: ["../x.jpg"] }), "BAD_REQUEST"]] as const) {
      expect(await db.rpc(owner, "aal2", "save_expense", [bad])).toMatchObject({ ok: false, error: err });
    }
  });

  it("management and finance see them; staff see nothing; nobody writes the table directly", async () => {
    expect((await db.as(owner, "aal2", "SELECT * FROM public.expenses")).rowCount).toBe(3);
    expect((await db.as(finance, "aal2", "SELECT * FROM public.expenses")).rowCount).toBe(3);
    expect((await db.as(staff, "aal1", "SELECT * FROM public.expenses")).rowCount).toBe(0);
    expect((await db.as(staff, "aal1", "SELECT * FROM public.expense_categories")).rowCount).toBe(0);
    await expect(db.as(owner, "aal2", "DELETE FROM public.expenses")).rejects.toThrow();
  });

  it("corrections keep who changed it; removing needs a reason and keeps the row", async () => {
    const id = (await db.sql("SELECT id FROM public.expenses WHERE amount_cents = 100")).rows[0].id;
    expect(await db.rpc(gm, "aal1", "save_expense", [exp({ id, amount_cents: 150000 })])).toMatchObject({ ok: true, id });
    const r = (await db.sql("SELECT amount_cents::int a, updated_by IS NOT NULL u FROM public.expenses WHERE id = $1", [id])).rows[0];
    expect(r).toEqual({ a: 150000, u: true });
    expect(await db.rpc(owner, "aal2", "void_expense", [id, ""])).toMatchObject({ ok: false, error: "REASON_REQUIRED" });
    expect(await db.rpc(owner, "aal2", "void_expense", [id, "Typed twice"])).toEqual({ ok: true });
    expect(await db.rpc(owner, "aal2", "save_expense", [exp({ id })])).toMatchObject({ ok: false, error: "NOT_FOUND" });
    expect((await db.sql("SELECT void_reason FROM public.expenses WHERE id = $1", [id])).rows[0].void_reason).toBe("Typed twice");
  });

  it("owners and the GM add categories and budgets; duplicates are refused", async () => {
    const r = await db.rpc(owner, "aal2", "save_expense_category", [JSON.stringify({ name: "DEMO Aircon cleaning", grp: "CLINIC", kind: "MONTHLY" })]);
    expect(r).toMatchObject({ ok: true });
    expect(await db.rpc(gm, "aal1", "save_expense_category", [JSON.stringify({ id: r.id, budget_cents: 500000 })])).toMatchObject({ ok: true });
    expect((await db.sql("SELECT budget_cents::int b FROM public.expense_categories WHERE id = $1", [r.id])).rows[0].b).toBe(500000);
    expect(await db.rpc(owner, "aal2", "save_expense_category", [JSON.stringify({ name: "rent" })])).toMatchObject({ ok: false, error: "DUPLICATE" });
    expect(await db.rpc(finance, "aal2", "save_expense_category", [JSON.stringify({ name: "DEMO X" })])).toMatchObject({ ok: false });
  });

  it("expense_auto: ad spend from the Windsor feed by page (newest copy), else the monthly table; payroll from final cutoffs", async () => {
    await db.sql(`INSERT INTO ads_feed.meta_ads_daily (date, actor_id, ad_id, spend, _loaded_at) VALUES
      ('2030-03-02', '101404945363588', 'a1', 100, now() - interval '1 day'),
      ('2030-03-02', '101404945363588', 'a1', 120, now()),
      ('2030-03-02', '103117851723422', 'a2', 50.5, now()),
      ('2030-03-03', '999', 'a3', 70, now())`);
    await db.sql("INSERT INTO public.ad_spend_monthly (organization_id, month, branch_id, service, spend_cents) VALUES ($1, '2030-02-01', $2, 'HIKO', 777700)", [org, db.branches.MARIKINA]);
    const r = await db.rpc(owner, "aal2", "expense_auto", ["2030-02-01", "2030-03-31"]);
    expect(r.ok).toBe(true);
    expect(r.ads).toEqual(expect.arrayContaining([
      { d: "2030-03-02", branch: "FAIRVIEW", cents: 12000 }, { d: "2030-03-02", branch: "QC_MAIN", cents: 5050 },
      expect.objectContaining({ d: "2030-02-01", branch: "MARIKINA", cents: 777700, monthly: true })]));
    expect(r.ads).toHaveLength(3);
    expect(r.ads_last_date).toBe("2030-03-02");
    expect(r.payroll).toEqual([]);
    expect(await db.rpc(staff, "aal1", "expense_auto", ["2030-02-01", "2030-03-31"])).toMatchObject({ ok: false });
    expect(await db.rpc(owner, "aal2", "expense_auto", ["2030-03-31", "2030-02-01"])).toMatchObject({ ok: false, error: "BAD_REQUEST" });
  });
});
