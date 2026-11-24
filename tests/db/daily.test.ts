// Daily sales entry, tracker upload rows and corrections. All data is DEMO.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, owner2: Person, gm: Person, fvManager: Person, cashier: Person;
let today = "";
const rows = (list: [string, number][]) => JSON.stringify(list.map(([date, cents]) => ({ date, cents })));
const total = async (code: string, date: string) =>
  (await db.sql("SELECT sum(gross_cents)::int AS c FROM public.historical_sales WHERE branch_id = $1 AND posting_date = $2 AND reversed_at IS NULL", [db.branches[code], date])).rows[0].c;

beforeAll(async () => {
  db = await TestDb.create();
  owner = await db.person("Owner", [["OWNER", null]]);
  owner2 = await db.person("Owner Two", [["OWNER", null]]);
  gm = await db.person("General Manager", [["MANAGER", null]]);
  fvManager = await db.person("Fairview Manager", [["MANAGER", "FAIRVIEW"]]);
  cashier = await db.person("Cashier", [["CASHIER", "FAIRVIEW"]]);
  today = (await db.sql("SELECT ((now() AT TIME ZONE 'Asia/Manila')::date)::text AS d")).rows[0].d;
  await db.sql("UPDATE public.organizations SET require_second_signoff = false");
}, 60_000);
afterAll(async () => db?.close());

describe("pre-launch (second sign-off off)", () => {
  it("an owner enters today's total and it counts at once", async () => {
    const r = await db.rpc(owner, "aal2", "record_daily_sales", [db.branches.QC_MAIN, rows([[today, 100000]]), "Daily sales"]);
    expect(r).toMatchObject({ ok: true, state: "PUBLISHED", rows: 1, cents: 100000 });
    expect(await total("QC_MAIN", today)).toBe(100000);
  });

  it("the general manager's entries publish too; a branch manager's wait for sign-off", async () => {
    expect((await db.rpc(gm, "aal1", "record_daily_sales", [db.branches.MARIKINA, rows([["2026-11-01", 5000], ["2026-11-02", 7000]]), "Tracker upload"])).state).toBe("PUBLISHED");
    expect(await total("MARIKINA", "2026-11-02")).toBe(7000);
    expect((await db.rpc(fvManager, "aal1", "record_daily_sales", [db.branches.FAIRVIEW, rows([["2026-11-01", 3000]]), null])).state).toBe("STAGED");
    expect(await total("FAIRVIEW", "2026-11-01")).toBeNull();
  });

  it("refuses the whole upload when any day is a problem", async () => {
    const r = await db.rpc(owner, "aal2", "record_daily_sales", [db.branches.MARIKINA,
      rows([["2026-11-02", 1], ["2026-11-03", 1], ["2026-11-03", 2], ["2999-01-01", 1], ["2026-11-04", 0]]), null]);
    expect(r.error).toBe("ROWS_REJECTED");
    expect(r.problems.map((p: any) => p.error).sort()).toEqual(["DAY_ALREADY_RECORDED", "DUPLICATE_DATE", "FUTURE_DATE", "INVALID_AMOUNT"]);
    expect(await total("MARIKINA", "2026-11-03")).toBeNull();
    // A day waiting for sign-off also counts as recorded.
    expect((await db.rpc(owner, "aal2", "record_daily_sales", [db.branches.FAIRVIEW, rows([["2026-11-01", 3000]]), null])).error).toBe("ROWS_REJECTED");
  });

  it("only owners, finance and managers can enter, each for their own branches", async () => {
    expect((await db.rpc(cashier, "aal1", "record_daily_sales", [db.branches.FAIRVIEW, rows([["2026-11-05", 1]]), null])).error).toBe("FORBIDDEN");
    expect((await db.rpc(fvManager, "aal1", "record_daily_sales", [db.branches.QC_MAIN, rows([["2026-11-05", 1]]), null])).error).toBe("FORBIDDEN");
  });

  it("a correction needs a reason and a second person, keeping the old row reversed", async () => {
    expect((await db.rpc(gm, "aal1", "request_sales_correction", [db.branches.MARIKINA, "2026-11-02", 7500, "typo"])).error).toBe("REASON_REQUIRED");
    expect((await db.rpc(gm, "aal1", "request_sales_correction", [db.branches.MARIKINA, "2026-11-02", 7000, "Same amount again"])).error).toBe("SAME_AMOUNT");
    expect((await db.rpc(gm, "aal1", "request_sales_correction", [db.branches.MARIKINA, "2026-11-09", 7000, "Nothing recorded"])).error).toBe("NOTHING_TO_CORRECT");
    const r = await db.rpc(gm, "aal1", "request_sales_correction", [db.branches.MARIKINA, "2026-11-02", 7500, "Sheet said 75, typed 70"]);
    expect(r.state).toBe("PENDING");
    expect(await total("MARIKINA", "2026-11-02")).toBe(7000);
    expect((await db.rpc(gm, "aal1", "decide_sales_correction", [r.id, true, null])).error).toBe("SELF_APPROVAL_DENIED");
    expect((await db.rpc(owner, "aal2", "decide_sales_correction", [r.id, true, null])).state).toBe("APPLIED");
    expect(await total("MARIKINA", "2026-11-02")).toBe(7500);
    const { rows: all } = await db.sql("SELECT count(*)::int AS n FROM public.historical_sales WHERE branch_id = $1 AND posting_date = '2026-11-02'", [db.branches.MARIKINA]);
    expect(all[0].n).toBe(2);
    expect(await db.auditCount("SALES_CORRECTED")).toBe(1);
  });
});

describe("after launch (second sign-off on)", () => {
  beforeAll(async () => db.sql("UPDATE public.organizations SET require_second_signoff = true"));

  it("an owner's entry waits for a second person", async () => {
    expect((await db.rpc(owner, "aal2", "record_daily_sales", [db.branches.STA_MARIA, rows([["2026-11-01", 4000]]), null])).state).toBe("STAGED");
  });

  it("a correction waits, the requester can't approve it, another owner can", async () => {
    const r = await db.rpc(owner, "aal2", "request_sales_correction", [db.branches.QC_MAIN, today, 120000, "Late GCash payment added"]);
    expect(r.state).toBe("PENDING");
    expect(await total("QC_MAIN", today)).toBe(100000);
    expect((await db.rpc(owner, "aal2", "request_sales_correction", [db.branches.QC_MAIN, today, 130000, "Another change now"])).error).toBe("CORRECTION_PENDING");
    expect((await db.rpc(owner, "aal2", "decide_sales_correction", [r.id, true, null])).error).toBe("SELF_APPROVAL_DENIED");
    expect((await db.rpc(fvManager, "aal1", "decide_sales_correction", [r.id, true, null])).error).toBe("FORBIDDEN");
    expect((await db.rpc(owner2, "aal2", "decide_sales_correction", [r.id, true, "ok"])).state).toBe("APPLIED");
    expect(await total("QC_MAIN", today)).toBe(120000);
  });

  it("rejecting a correction needs a note", async () => {
    const r = await db.rpc(gm, "aal1", "request_sales_correction", [db.branches.MARIKINA, "2026-11-01", 6000, "Recount of envelope"]);
    expect(r.state).toBe("PENDING");
    expect((await db.rpc(owner2, "aal2", "decide_sales_correction", [r.id, false, ""])).error).toBe("NOTE_REQUIRED");
    expect((await db.rpc(owner2, "aal2", "decide_sales_correction", [r.id, false, "Envelope matched"])).state).toBe("REJECTED");
    expect(await total("MARIKINA", "2026-11-01")).toBe(5000);
  });
});

describe("daily_sales_status", () => {
  it("shows recorded, waiting and the service log total per branch and day", async () => {
    const r = await db.rpc(owner, "aal2", "daily_sales_status", ["2026-11-01", today]);
    expect(r.ok).toBe(true);
    const day = (code: string, d: string) => r.days.find((x: any[]) => x[0] === db.branches[code] && x[1] === d);
    expect(day("MARIKINA", "2026-11-02").slice(2, 5)).toEqual([7500, null, false]);
    expect(day("FAIRVIEW", "2026-11-01").slice(2, 5)).toEqual([null, null, true]);
    expect(r.branches.find((b: any) => b.code === "QC_MAIN")).toMatchObject({ can_enter: true, can_approve: true, self_publish: false });
    const mine = await db.rpc(fvManager, "aal1", "daily_sales_status", ["2026-11-01", today]);
    expect(mine.branches.map((b: any) => b.code)).toEqual(["FAIRVIEW"]);
    expect(mine.days.every((x: any[]) => x[0] === db.branches.FAIRVIEW)).toBe(true);
  });
});
