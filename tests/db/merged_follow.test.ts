// update-0102: lines merged under a main sale move with it (branch, date) and take its client name fix. DEMO fixtures only.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, staff: Person;
let ana: string, svc: string, pack: string;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());
const yesterday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date(Date.now() - 86_400_000));

beforeAll(async () => {
  db = await TestDb.create();
  owner = await db.person("Owner", [["OWNER", null]]);
  staff = await db.person("Fairview Staff", [["CLINICIAN", "FAIRVIEW"]]);
  ana = (await db.rpc(owner, "aal2", "save_employee", [null, db.branches.FAIRVIEW, "DEMO Ana", "CMA", true, staff.appUserId, true])).id;
  svc = (await db.rpc(owner, "aal2", "save_service", [null, "DEMO Thread Lift", 900000, null, true])).id;
  pack = (await db.rpc(owner, "aal2", "save_service", [null, "DEMO Meds Package", 80000, 0, true])).id;
  await db.sql("UPDATE public.services SET is_meds = true WHERE id = $1", [pack]);
}, 60_000);
afterAll(async () => db?.close());

const visit = async (client = "DEMO Client") => {
  const folder = randomUUID();
  const list = ["WAIVER", "WAIVER", "BEFORE", "AFTER"].map((k) => ({ kind: k, path: `${db.branches.FAIRVIEW}/${folder}/${k.toLowerCase()}-${randomUUID()}.jpg`, thumb: null }));
  const v = await db.rpc(staff, "aal1", "log_client_visit", [db.branches.FAIRVIEW, today(), svc, 900000, "SOLO", ana, null, null,
    "PAID", true, client, null, folder, JSON.stringify(list), false]);
  const m = await db.rpc(staff, "aal1", "log_meds", [v.id, pack, false]);
  expect(m).toMatchObject({ ok: true });
  return { main: v.id as string, line: m.id as string };
};
const row = async (id: string) => (await db.sql(`SELECT branch_id, service_date::text d, client_name, merged_into FROM public.service_logs WHERE id = $1`, [id])).rows[0];

describe("merged lines follow their main sale", () => {
  it("changing the branch moves the whole visit, also when asked on a merged line", async () => {
    const v = await visit();
    expect(await db.rpc(owner, "aal2", "change_service_branch", [v.main, db.branches.MARIKINA])).toMatchObject({ ok: true, moved: 2 });
    expect(await row(v.line)).toMatchObject({ branch_id: db.branches.MARIKINA, merged_into: v.main });
    expect(await db.rpc(owner, "aal2", "change_service_branch", [v.line, db.branches.FAIRVIEW])).toMatchObject({ ok: true, id: v.main, moved: 2 });
    expect((await row(v.main)).branch_id).toBe(db.branches.FAIRVIEW);
  });

  it("changing the date moves the whole visit", async () => {
    const v = await visit();
    expect(await db.rpc(owner, "aal2", "change_service_date", [v.main, yesterday()])).toMatchObject({ ok: true, moved: 2 });
    expect(await row(v.line)).toMatchObject({ d: yesterday(), merged_into: v.main });
  });

  it("fixing the client name fixes every line of the visit", async () => {
    const v = await visit("DEMO Clent");
    expect(await db.rpc(staff, "aal1", "rename_service_client", [v.main, "DEMO Client Fixed", false])).toMatchObject({ ok: true, changed: 2 });
    expect((await row(v.line)).client_name).toBe("DEMO Client Fixed");
  });

  it("the repair puts lines left behind back on their main sale's branch and date", async () => {
    const v = await visit();
    // As before update-0102: the main sale moved alone (simulated in one transaction with the guard flag set).
    await db.sql(`BEGIN; SELECT set_config('hermosa.log_rebranch', 'on', true);
      UPDATE public.service_logs SET branch_id = '${db.branches.MARIKINA}' WHERE id = '${v.main}'; COMMIT;`);
    await db.sql(`BEGIN; SELECT set_config('hermosa.log_redate', 'on', true);
      UPDATE public.service_logs SET service_date = '${yesterday()}' WHERE id = '${v.main}'; COMMIT;`);
    expect((await row(v.line)).branch_id).toBe(db.branches.FAIRVIEW);
    const sql = readFileSync("supabase/migrations/20261128000102_merged_follow.sql", "utf8");
    await db.sql(sql.slice(sql.indexOf("-- 4. One-time repair")));
    expect(await row(v.line)).toMatchObject({ branch_id: db.branches.MARIKINA, d: yesterday(), merged_into: v.main });
  });
});
