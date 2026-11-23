// Dashboard daily data and missing-day fill-in. All data is DEMO.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, finance: Person, fvManager: Person, mkManager: Person;

beforeAll(async () => {
  db = await TestDb.create();
  owner = await db.person("Owner", [["OWNER", null]]);
  finance = await db.person("Finance", [["FINANCE", null]]);
  fvManager = await db.person("Fairview Manager", [["MANAGER", "FAIRVIEW"]]);
  mkManager = await db.person("Marikina Manager", [["MANAGER", "MARIKINA"]]);
  const csv = "source_id,posting_date,amount_php\nD-1,2025-03-01,100.00\nD-2,2025-03-01,50.00\nD-3,2025-03-03,10.00\n";
  const s = await db.stage(fvManager, "aal1", "FAIRVIEW", csv, 3, 16000);
  expect((await db.rpc(owner, "aal2", "publish_historical_batch", [s.id, 3, 16000])).ok).toBe(true);
}, 60_000);

afterAll(async () => db?.close());

describe("historical_sales_daily", () => {
  it("gives the owner daily totals per branch, first recorded day, and consolidated flag", async () => {
    const r = await db.rpc(owner, "aal2", "historical_sales_daily", ["2025-03-01", "2025-03-31"]);
    expect(r.ok).toBe(true);
    expect(r.consolidated).toBe(true);
    expect(r.branches).toHaveLength(4);
    expect(r.days).toEqual([[db.branches.FAIRVIEW, "2025-03-01", 15000], [db.branches.FAIRVIEW, "2025-03-03", 1000]]);
    expect(r.branches.find((b: any) => b.code === "FAIRVIEW").first_date).toBe("2025-03-01");
  });

  it("a branch manager only sees their own branch", async () => {
    const r = await db.rpc(mkManager, "aal1", "historical_sales_daily", ["2025-03-01", "2025-03-31"]);
    expect(r.consolidated).toBe(false);
    expect(r.branches.map((b: any) => b.code)).toEqual(["MARIKINA"]);
    expect(r.days).toEqual([]);
  });

  it("an owner without MFA sees nothing", async () => {
    const r = await db.rpc(owner, "aal1", "historical_sales_daily", ["2025-03-01", "2025-03-31"]);
    expect(r.branches).toEqual([]);
    expect(r.days).toEqual([]);
  });
});

describe("fill_missing_day", () => {
  it("a Closed mark waits for a second person; the marker can't confirm it; another owner can", async () => {
    const res = await db.rpc(fvManager, "aal1", "fill_missing_day", [db.branches.FAIRVIEW, "2025-03-02", "CLOSED", null, "Holiday"]);
    expect(res).toMatchObject({ ok: true, state: "PENDING" });
    expect(await db.auditCount("ZERO_DAY_MARKED")).toBe(1);
    expect((await db.rpc(fvManager, "aal2", "decide_zero_day", [res.id, true, null])).error).toBe("FORBIDDEN");
    const pend = await db.rpc(owner, "aal2", "historical_sales_daily", ["2025-03-01", "2025-03-31"]);
    expect(pend.closed[0].slice(0, 4)).toEqual([db.branches.FAIRVIEW, "2025-03-02", "CLOSED", "PENDING"]);
    expect((await db.rpc(owner, "aal1", "decide_zero_day", [res.id, true, null])).error).toBe("MFA_REQUIRED");
    expect((await db.rpc(owner, "aal2", "decide_zero_day", [res.id, true, null])).state).toBe("CONFIRMED");
    expect((await db.rpc(finance, "aal2", "decide_zero_day", [res.id, false, null])).error).toBe("NOT_PENDING");
    expect(await db.auditCount("ZERO_DAY_CONFIRMED")).toBe(1);
    const again = await db.rpc(fvManager, "aal1", "fill_missing_day", [db.branches.FAIRVIEW, "2025-03-02", "AMOUNT", 500, null]);
    expect(again.error).toBe("DAY_ALREADY_RECORDED");
    const r = await db.rpc(owner, "aal2", "historical_sales_daily", ["2025-03-01", "2025-03-31"]);
    expect(r.closed[0].slice(0, 4)).toEqual([db.branches.FAIRVIEW, "2025-03-02", "CLOSED", "CONFIRMED"]);
  });

  it("an owner can't confirm their own No sales mark, even with import sign-off off; a rejected day can be marked again", async () => {
    await db.sql("UPDATE public.organizations SET require_second_signoff = false");
    try {
      const m = await db.rpc(owner, "aal2", "fill_missing_day", [db.branches.FAIRVIEW, "2025-03-10", "NO_SALES", null, null]);
      expect(m.state).toBe("PENDING");
      expect((await db.rpc(owner, "aal2", "decide_zero_day", [m.id, true, null])).error).toBe("SELF_APPROVAL_DENIED");
      expect((await db.rpc(finance, "aal2", "decide_zero_day", [m.id, false, null])).state).toBe("REJECTED");
      const again = await db.rpc(owner, "aal2", "fill_missing_day", [db.branches.FAIRVIEW, "2025-03-10", "CLOSED", null, null]);
      expect(again.state).toBe("PENDING");
    } finally {
      await db.sql("UPDATE public.organizations SET require_second_signoff = true");
    }
  });

  it("nobody can confirm a mark by writing the table directly", async () => {
    await expect(db.as(owner, "aal2", "UPDATE public.sales_day_status SET state = 'CONFIRMED'")).rejects.toThrow(/permission denied/);
  });

  it("a manager cannot fill another branch's day", async () => {
    const res = await db.rpc(mkManager, "aal1", "fill_missing_day", [db.branches.FAIRVIEW, "2025-03-04", "AMOUNT", 500, null]);
    expect(res.error).toBe("FORBIDDEN");
  });

  it("a manager's amount waits for sign-off; it doesn't count yet", async () => {
    const res = await db.rpc(fvManager, "aal1", "fill_missing_day", [db.branches.FAIRVIEW, "2025-03-04", "AMOUNT", 12345, null]);
    expect(res).toMatchObject({ ok: true, state: "STAGED" });
    const r = await db.rpc(owner, "aal2", "historical_sales_daily", ["2025-03-04", "2025-03-04"]);
    expect(r.days).toEqual([]);
  });

  it("with sign-off off, an MFA owner's amount publishes at once; with it on, it waits", async () => {
    await db.sql("UPDATE public.organizations SET require_second_signoff = false");
    try {
      const res = await db.rpc(owner, "aal2", "fill_missing_day", [db.branches.FAIRVIEW, "2025-03-05", "AMOUNT", 250075, null]);
      expect(res).toMatchObject({ ok: true, state: "PUBLISHED" });
      const r = await db.rpc(owner, "aal2", "historical_sales_daily", ["2025-03-05", "2025-03-05"]);
      expect(r.days).toEqual([[db.branches.FAIRVIEW, "2025-03-05", 250075]]);
      // finance can't self-publish even with the switch off
      const f = await db.rpc(finance, "aal2", "fill_missing_day", [db.branches.FAIRVIEW, "2025-03-06", "AMOUNT", 100, null]);
      expect(f.state).toBe("STAGED");
    } finally {
      await db.sql("UPDATE public.organizations SET require_second_signoff = true");
    }
    const res = await db.rpc(owner, "aal2", "fill_missing_day", [db.branches.FAIRVIEW, "2025-03-07", "AMOUNT", 100, null]);
    expect(res.state).toBe("STAGED");
  });

  it("rejects today, future days and bad amounts", async () => {
    expect((await db.rpc(owner, "aal2", "fill_missing_day", [db.branches.FAIRVIEW, "2999-01-01", "AMOUNT", 100, null])).error).toBe("INVALID_DATE");
    expect((await db.rpc(owner, "aal2", "fill_missing_day", [db.branches.FAIRVIEW, "2025-03-08", "AMOUNT", 0, null])).error).toBe("INVALID_AMOUNT");
  });
});
