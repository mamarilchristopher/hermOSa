// Zero sales / Closed marks from the Daily Sales grid. All data is DEMO.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, gm: Person, fvManager: Person, cashier: Person;
let today = "";
const days = (list: [string, string][]) => JSON.stringify(list.map(([date, status]) => ({ date, status })));
const mark = async (code: string, date: string) =>
  (await db.sql("SELECT status, state FROM public.sales_day_status WHERE branch_id = $1 AND business_date = $2 AND state <> 'REJECTED'", [db.branches[code], date])).rows[0];

beforeAll(async () => {
  db = await TestDb.create();
  owner = await db.person("Owner", [["OWNER", null]]);
  gm = await db.person("General Manager", [["MANAGER", null]]);
  fvManager = await db.person("Fairview Manager", [["MANAGER", "FAIRVIEW"]]);
  cashier = await db.person("Cashier", [["CASHIER", "FAIRVIEW"]]);
  today = (await db.sql("SELECT ((now() AT TIME ZONE 'Asia/Manila')::date)::text AS d")).rows[0].d;
  await db.sql("UPDATE public.organizations SET require_second_signoff = false");
}, 60_000);
afterAll(async () => db?.close());

describe("mark_sales_days", () => {
  it("the general manager marks days (today included) and they count at once before launch", async () => {
    const r = await db.rpc(gm, "aal1", "mark_sales_days", [db.branches.MARIKINA, days([[today, "CLOSED"], ["2026-11-03", "NO_SALES"]])]);
    expect(r).toMatchObject({ ok: true, state: "CONFIRMED", count: 2 });
    expect(await mark("MARIKINA", today)).toEqual({ status: "CLOSED", state: "CONFIRMED" });
    expect(await mark("MARIKINA", "2026-11-03")).toEqual({ status: "NO_SALES", state: "CONFIRMED" });
  });

  it("a branch manager's marks wait for a second person", async () => {
    expect((await db.rpc(fvManager, "aal1", "mark_sales_days", [db.branches.FAIRVIEW, days([["2026-11-03", "CLOSED"]])])).state).toBe("PENDING");
  });

  it("refuses all marks when any day is a problem, and blocks amounts on marked days", async () => {
    const r = await db.rpc(owner, "aal2", "mark_sales_days", [db.branches.MARIKINA,
      days([["2026-11-03", "CLOSED"], ["2026-11-04", "CLOSED"], ["2026-11-04", "NO_SALES"], ["2999-01-01", "CLOSED"], ["2026-11-05", "OPEN"]])]);
    expect(r.error).toBe("ROWS_REJECTED");
    expect(r.problems.map((p: any) => p.error).sort()).toEqual(["BAD_REQUEST", "DAY_ALREADY_RECORDED", "DUPLICATE_DATE", "FUTURE_DATE"]);
    expect(await mark("MARIKINA", "2026-11-04")).toBeUndefined();
    const e = await db.rpc(owner, "aal2", "record_daily_sales", [db.branches.MARIKINA, JSON.stringify([{ date: "2026-11-03", cents: 100 }]), null]);
    expect(e.error).toBe("ROWS_REJECTED");
  });

  it("only owners, finance and managers of the branch can mark", async () => {
    expect((await db.rpc(cashier, "aal1", "mark_sales_days", [db.branches.FAIRVIEW, days([["2026-11-06", "CLOSED"]])])).error).toBe("FORBIDDEN");
    expect((await db.rpc(fvManager, "aal1", "mark_sales_days", [db.branches.QC_MAIN, days([["2026-11-06", "CLOSED"]])])).error).toBe("FORBIDDEN");
  });

  it("with second sign-off on, even the general manager's marks wait", async () => {
    await db.sql("UPDATE public.organizations SET require_second_signoff = true");
    expect((await db.rpc(gm, "aal1", "mark_sales_days", [db.branches.QC_MAIN, days([["2026-11-07", "NO_SALES"]])])).state).toBe("PENDING");
  });
});
