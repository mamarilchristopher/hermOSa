// Sales notices to management and the two-person rule for any change after saving. All data is DEMO.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, owner2: Person, gm: Person, fvManager: Person, qcManager: Person, cashier: Person;
const D = "2026-11-05";
const notes = async (p: Person) =>
  (await db.sql("SELECT kind, title, body FROM public.notifications WHERE user_id = $1 ORDER BY created_at", [p.appUserId])).rows;
const total = async (date: string) =>
  (await db.sql("SELECT sum(gross_cents)::int AS c FROM public.historical_sales WHERE branch_id = $1 AND posting_date = $2 AND reversed_at IS NULL", [db.branches.FAIRVIEW, date])).rows[0].c;

beforeAll(async () => {
  db = await TestDb.create();
  owner = await db.person("Owner", [["OWNER", null]]);
  owner2 = await db.person("Owner Two", [["OWNER", null]]);
  gm = await db.person("General Manager", [["MANAGER", null]]);
  fvManager = await db.person("Fairview Manager", [["MANAGER", "FAIRVIEW"]]);
  qcManager = await db.person("QC Manager", [["MANAGER", "QC_MAIN"]]);
  cashier = await db.person("Cashier", [["CASHIER", "FAIRVIEW"]]);
  await db.sql("UPDATE public.organizations SET require_second_signoff = false");
}, 60_000);
afterAll(async () => db?.close());

describe("sales notices", () => {
  it("a new day total notifies every other management member of the branch", async () => {
    expect((await db.rpc(gm, "aal1", "record_daily_sales", [db.branches.FAIRVIEW, JSON.stringify([{ date: D, cents: 250000 }]), null])).state).toBe("PUBLISHED");
    for (const p of [owner, owner2, fvManager]) {
      const n = await notes(p);
      expect(n).toHaveLength(1);
      expect(n[0]).toMatchObject({ kind: "SALES_ENTERED" });
      expect(n[0].body).toContain("Fairview: Nov 5 ₱2,500.00");
      expect(n[0].body).toContain("General Manager.");
    }
    for (const p of [gm, qcManager, cashier]) expect(await notes(p)).toHaveLength(0);
  });

  it("Zero sales / Closed marks notify too", async () => {
    await db.rpc(owner, "aal2", "mark_sales_days", [db.branches.FAIRVIEW, JSON.stringify([{ date: "2026-11-07", status: "CLOSED" }, { date: "2026-11-08", status: "NO_SALES" }])]);
    const n = (await notes(gm)).at(-1);
    expect(n.kind).toBe("SALES_MARKED");
    expect(n.body).toContain("Nov 7 Closed, Nov 8 Zero sales");
  });

  it("any change to a saved day waits for a different person, even before launch", async () => {
    const r = await db.rpc(owner, "aal2", "request_sales_correction", [db.branches.FAIRVIEW, D, 300000, "Late GCash payment found"]);
    expect(r).toMatchObject({ state: "PENDING", needs_two: true });
    expect(await total(D)).toBe(250000);
    expect((await notes(gm)).at(-1).kind).toBe("SALES_CHANGE_WAITING");
    expect((await notes(gm)).at(-1).body).toContain("₱2,500.00 → ₱3,000.00");
    expect((await db.rpc(owner, "aal2", "decide_sales_correction", [r.id, true, null])).error).toBe("SELF_APPROVAL_DENIED");
    expect((await db.rpc(fvManager, "aal1", "decide_sales_correction", [r.id, true, null])).error).toBe("FORBIDDEN");
    expect((await db.rpc(gm, "aal1", "decide_sales_correction", [r.id, true, null])).state).toBe("APPLIED");
    expect(await total(D)).toBe(300000);
    expect((await notes(owner)).at(-1)).toMatchObject({ kind: "SALES_CHANGED", title: "Sales change confirmed" });
  });

  it("a rejected change notifies too and leaves the total alone", async () => {
    const r = await db.rpc(gm, "aal1", "request_sales_correction", [db.branches.FAIRVIEW, D, 1000, "Testing a wrong value"]);
    expect(r.state).toBe("PENDING");
    expect((await db.rpc(owner2, "aal2", "decide_sales_correction", [r.id, false, "Not right"])).state).toBe("REJECTED");
    expect(await total(D)).toBe(300000);
    expect((await notes(gm)).at(-1).kind).toBe("SALES_CHANGE_REJECTED");
  });

  it("people only see and clear their own notices", async () => {
    const seen = await db.as(owner, "aal2", "SELECT user_id FROM public.notifications");
    expect(new Set(seen.rows.map((x: any) => x.user_id))).toEqual(new Set([owner.appUserId]));
    expect((await db.rpc(owner, "aal2", "mark_notifications_read", [null])).count).toBeGreaterThan(0);
    expect((await db.sql("SELECT count(*)::int AS n FROM public.notifications WHERE user_id = $1 AND read_at IS NULL", [owner2.appUserId])).rows[0].n).toBeGreaterThan(0);
  });

  it("lists the days already changed", async () => {
    expect(await db.rpc(owner, "aal2", "changed_sales_days", ["2026-11-01", "2026-11-30"])).toEqual([[db.branches.FAIRVIEW, D]]);
  });

  it("a saved day can be changed to Zero sales (after a second person confirms)", async () => {
    const day = "2026-11-06";
    await db.rpc(owner, "aal2", "record_daily_sales", [db.branches.FAIRVIEW, JSON.stringify([{ date: day, cents: 90000 }]), null]);
    const r = await db.rpc(owner, "aal2", "request_sales_correction", [db.branches.FAIRVIEW, day, 0, "Branch was actually closed"]);
    expect(r.state).toBe("PENDING");
    expect((await db.rpc(owner2, "aal2", "decide_sales_correction", [r.id, true, null])).state).toBe("APPLIED");
    expect(await total(day)).toBeNull();
    const m = (await db.sql("SELECT status, state FROM public.sales_day_status WHERE branch_id = $1 AND business_date = $2", [db.branches.FAIRVIEW, day])).rows[0];
    expect(m).toEqual({ status: "NO_SALES", state: "CONFIRMED" });
    expect((await db.rpc(owner, "aal2", "request_sales_correction", [db.branches.FAIRVIEW, day, -5, "Negative is never ok"])).error).toBe("INVALID_AMOUNT");
  });
});
