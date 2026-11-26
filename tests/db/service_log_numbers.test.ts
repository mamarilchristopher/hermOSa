// update-0079: service log numbers SL-YYMM-NNNN, re-numbered in order once a month is final. DEMO fixtures only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, gm: Person;
let svc: string;
const emp: Record<string, string> = {};

beforeAll(async () => {
  db = await TestDb.create();
  owner = await db.person("Owner", [["OWNER", null]]);
  gm = await db.person("General Manager", [["MANAGER", null]]);
  for (const b of ["QC_MAIN", "FAIRVIEW", "MARIKINA"] as const) {
    emp[b] = (await db.rpc(owner, "aal2", "save_employee", [null, db.branches[b], `DEMO ${b}`, "CMA", true, null, true])).id;
  }
  svc = (await db.rpc(owner, "aal2", "save_service", [null, "DEMO Facial", 100000, 5000, true])).id;
}, 60_000);
afterAll(async () => db?.close());

const log = async (b: "QC_MAIN" | "FAIRVIEW" | "MARIKINA", date: string) => {
  const v = await db.rpc(owner, "aal2", "log_client_visit", [db.branches[b], date, svc, 100000, "SOLO", emp[b], null, null,
    "PAID", true, `DEMO Client ${b}`, null, randomUUID(), "[]", false]);
  expect(v.ok).toBe(true);
  return v.id as string;
};
const no = async (id: string) => (await db.sql("SELECT log_no FROM public.service_logs WHERE id = $1", [id])).rows[0].log_no as string;

describe("service log numbers", () => {
  it("new entries get the next number of their service month, even when entered out of order", async () => {
    const a = await log("MARIKINA", "2026-10-20");
    const b = await log("QC_MAIN", "2026-10-10");
    const c = await log("FAIRVIEW", "2026-10-10");
    const d = await log("FAIRVIEW", "2026-09-30");
    expect([await no(a), await no(b), await no(c), await no(d)]).toEqual(["SL-2610-0001", "SL-2610-0002", "SL-2610-0003", "SL-2609-0001"]);
  });

  it("owners re-number a final month by date, then branch (QC Main first); the GM can't", async () => {
    expect(await db.rpc(gm, "aal1", "renumber_service_logs", ["2026-10-01"])).toMatchObject({ ok: false, error: "FORBIDDEN" });
    expect(await db.rpc(owner, "aal2", "renumber_service_logs", ["2026-10-15"])).toMatchObject({ ok: true, entries: 3 });
    const rows = (await db.sql("SELECT l.log_no, l.service_date::text d, b.code FROM public.service_logs l JOIN public.branches b ON b.id = l.branch_id WHERE l.log_no LIKE 'SL-2610-%' ORDER BY l.log_no")).rows;
    expect(rows.map((r) => [r.log_no, r.d, r.code])).toEqual([
      ["SL-2610-0001", "2026-10-10", "QC_MAIN"], ["SL-2610-0002", "2026-10-10", "FAIRVIEW"], ["SL-2610-0003", "2026-10-20", "MARIKINA"]]);
    // The next entry continues the month; other months are untouched.
    expect(await no(await log("QC_MAIN", "2026-10-05"))).toBe("SL-2610-0004");
    expect((await db.sql("SELECT log_no FROM public.service_logs WHERE service_date = '2026-09-30'")).rows[0].log_no).toBe("SL-2609-0001");
    // Approved entries stay locked otherwise.
    await expect(db.sql("UPDATE public.service_logs SET log_no = 'X' WHERE log_no = 'SL-2610-0001'")).rejects.toThrow(/SERVICE_LOG/);
  });

  it("an entry whose date moved to another month gets a number in its new month when the old month is re-numbered", async () => {
    const e = await log("FAIRVIEW", "2026-08-03");
    const f = await log("FAIRVIEW", "2026-08-04");
    expect(await no(e)).toBe("SL-2608-0001");
    expect((await db.rpc(owner, "aal2", "change_service_date", [e, "2026-07-03"])).ok).toBe(true);
    expect(await db.rpc(owner, "aal2", "renumber_service_logs", ["2026-08-01"])).toMatchObject({ ok: true, entries: 1 });
    expect(await no(f)).toBe("SL-2608-0001");
    expect(await no(e)).toBe("SL-2607-0001");
  });
});
