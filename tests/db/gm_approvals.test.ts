// update-0028: the General Manager gives every owner-level approval (Closed / No sales days, sales imports).
// Staff details and join requests are covered in details.test.ts and invites.test.ts. All data is DEMO.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let gm: Person, fvManager: Person;
const CSV = "source_id,posting_date,amount_php\nDEMO-GM-1,2026-10-01,100.00\nDEMO-GM-2,2026-10-02,50.00\n";
const CSV2 = "source_id,posting_date,amount_php\nDEMO-GM-3,2026-10-03,10.00\n";

beforeAll(async () => {
  db = await TestDb.create();
  gm = await db.person("General Manager", [["MANAGER", null]]);
  fvManager = await db.person("Fairview Manager", [["MANAGER", "FAIRVIEW"]]);
}, 60_000);
afterAll(async () => db?.close());

describe("General Manager approvals", () => {
  it("confirms a branch manager's Closed day; the branch manager can't confirm it", async () => {
    const r = await db.rpc(fvManager, "aal1", "mark_sales_days", [db.branches.FAIRVIEW, JSON.stringify([{ date: "2026-11-03", status: "CLOSED" }])]);
    expect(r.state).toBe("PENDING");
    const { rows } = await db.sql("SELECT id FROM public.sales_day_status WHERE branch_id = $1 AND business_date = '2026-11-03'", [db.branches.FAIRVIEW]);
    expect((await db.rpc(fvManager, "aal1", "decide_zero_day", [rows[0].id, true, null])).ok).toBe(false);
    expect((await db.rpc(gm, "aal1", "decide_zero_day", [rows[0].id, true, null])).state).toBe("CONFIRMED");
  });

  it("signs off a branch manager's upload; the uploader can't", async () => {
    const s = await db.stage(fvManager, "aal1", "FAIRVIEW", CSV, 2, 15000);
    expect(s.state).toBe("STAGED");
    expect((await db.rpc(fvManager, "aal1", "publish_historical_batch", [s.id, 2, 15000])).ok).toBe(false);
    expect((await db.rpc(gm, "aal1", "publish_historical_batch", [s.id, 2, 15000])).state).toBe("PUBLISHED");
  });

  it("signs off her own upload only while the pre-launch switch is off", async () => {
    const s = await db.stage(gm, "aal1", "QC_MAIN", CSV2, 1, 1000);
    expect((await db.rpc(gm, "aal1", "publish_historical_batch", [s.id, 1, 1000])).error).toBe("SELF_APPROVAL_DENIED");
    await db.sql("UPDATE public.organizations SET require_second_signoff = false");
    expect((await db.rpc(gm, "aal1", "publish_historical_batch", [s.id, 1, 1000])).state).toBe("PUBLISHED");
  });
});
