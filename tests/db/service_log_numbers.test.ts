// update-0079 / update-0098: service log numbers SL-DDMMYY-NNN, re-numbered in order once a month is final. DEMO fixtures only.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
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

describe("service log numbers (update-0098: SL-DDMMYY-NNN, count per day)", () => {
  it("new entries get the next number of their service day, even when entered out of order", async () => {
    const a = await log("MARIKINA", "2026-10-10");
    const b = await log("QC_MAIN", "2026-10-10");
    const c = await log("FAIRVIEW", "2026-10-20");
    const d = await log("FAIRVIEW", "2026-09-30");
    expect([await no(a), await no(b), await no(c), await no(d)]).toEqual(["SL-101026-001", "SL-101026-002", "SL-201026-001", "SL-300926-001"]);
  });

  it("owners re-number a final month: per day, branch order (QC Main first); the GM can't", async () => {
    expect(await db.rpc(gm, "aal1", "renumber_service_logs", ["2026-10-01"])).toMatchObject({ ok: false, error: "FORBIDDEN" });
    expect(await db.rpc(owner, "aal2", "renumber_service_logs", ["2026-10-15"])).toMatchObject({ ok: true, entries: 3 });
    const rows = (await db.sql("SELECT l.log_no, l.service_date::text d, b.code FROM public.service_logs l JOIN public.branches b ON b.id = l.branch_id WHERE l.service_date BETWEEN '2026-10-01' AND '2026-10-31' ORDER BY l.service_date, l.log_no")).rows;
    expect(rows.map((r) => [r.log_no, r.d, r.code])).toEqual([
      ["SL-101026-001", "2026-10-10", "QC_MAIN"], ["SL-101026-002", "2026-10-10", "MARIKINA"], ["SL-201026-001", "2026-10-20", "FAIRVIEW"]]);
    expect(await no(await log("QC_MAIN", "2026-10-10"))).toBe("SL-101026-003");
    expect((await db.sql("SELECT log_no FROM public.service_logs WHERE service_date = '2026-09-30'")).rows[0].log_no).toBe("SL-300926-001");
    await expect(db.sql("UPDATE public.service_logs SET log_no = 'X' WHERE log_no = 'SL-101026-001'")).rejects.toThrow(/SERVICE_LOG/);
  });

  it("an entry whose date moved gets a number on its new day when the old month is re-numbered", async () => {
    const e = await log("FAIRVIEW", "2026-08-03");
    const f = await log("FAIRVIEW", "2026-08-04");
    expect(await no(e)).toBe("SL-030826-001");
    expect((await db.rpc(owner, "aal2", "change_service_date", [e, "2026-07-03"])).ok).toBe(true);
    expect(await db.rpc(owner, "aal2", "renumber_service_logs", ["2026-08-01"])).toMatchObject({ ok: true, entries: 1 });
    expect(await no(f)).toBe("SL-040826-001");
    expect(await no(e)).toBe("SL-030726-001");
  });

  it("converts old SL-YYMM-NNNN numbers, keeps them as old codes, and renames old-number placeholders", async () => {
    const g = await log("QC_MAIN", "2026-11-05");
    const h = await log("FAIRVIEW", "2026-11-05");
    // Pretend these were numbered before update-0098; h's client name is the old-import placeholder (its own number).
    await db.sql(`BEGIN; SELECT set_config('hermosa.log_renumber', 'on', true);
      UPDATE public.service_logs SET log_no = 'SL-2611-0001' WHERE id = '${g}'; UPDATE public.service_logs SET log_no = 'SL-2611-0002' WHERE id = '${h}'; COMMIT;`);
    await db.sql(`BEGIN; SELECT set_config('hermosa.booking_link', 'on', true); UPDATE public.service_logs SET client_name = 'SL-2611-0002' WHERE id = '${h}'; COMMIT;`);
    const file = readFileSync(new URL("../../supabase/migrations/20261127000098_sl_numbers_by_day.sql", import.meta.url), "utf8");
    await db.sql(file.slice(file.indexOf("-- One-time conversion"), file.indexOf("-- Shows a few converted numbers")));
    const r = (await db.sql("SELECT id, log_no, old_log_no, client_name FROM public.service_logs WHERE id = ANY($1) ORDER BY log_no", [[g, h]])).rows;
    expect(r.map((x) => [x.log_no, x.old_log_no])).toEqual([["SL-051126-001", "SL-2611-0001"], ["SL-051126-002", "SL-2611-0002"]]);
    expect(r.find((x) => x.id === h)!.client_name).toBe("SL-051126-002");
    // Running it again changes nothing.
    await db.sql(file.slice(file.indexOf("-- One-time conversion"), file.indexOf("-- Shows a few converted numbers")));
    expect(await no(g)).toBe("SL-051126-001");
  });
});
