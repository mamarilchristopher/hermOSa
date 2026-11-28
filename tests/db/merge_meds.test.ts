// update-0101: a meds / add-on line goes under the main sale's SL number (merge, separate, renumbering). DEMO fixtures only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, staff: Person;
let ana: string, svc: string, pack: string;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());

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
  return db.rpc(staff, "aal1", "log_client_visit", [db.branches.FAIRVIEW, today(), svc, 900000, "SOLO", ana, null, null,
    "PAID", true, client, null, folder, JSON.stringify(list), false]);
};
const row = async (id: string) => (await db.sql(`SELECT log_no, merged_into, state, amount_paid_cents::int amt FROM public.service_logs WHERE id = $1`, [id])).rows[0];
/** A meds line saved on its own (as before update-0101), not yet under the main sale. */
const loose = async (main: string) => {
  const m = await db.rpc(staff, "aal1", "log_meds", [main, pack, false]);
  expect(await db.rpc(owner, "aal2", "separate_service_entry", [m.id])).toMatchObject({ ok: true });
  return m.id as string;
};

describe("merge meds into the main sale", () => {
  it("meds picked when logging go under the main sale's number by themselves", async () => {
    const v = await visit();
    const m = await db.rpc(staff, "aal1", "log_meds", [v.id, pack, false]);
    expect(m).toMatchObject({ ok: true });
    expect(await row(m.id)).toMatchObject({ log_no: null, merged_into: v.id, amt: 80000 });
    expect((await row(v.id)).log_no).toMatch(/^SL-\d{6}-\d{3}$/);
  });

  it("separate gives the line its own number; merge takes it back under the main sale", async () => {
    const v = await visit();
    const id = await loose(v.id);
    expect(await row(id)).toMatchObject({ merged_into: null });
    expect((await row(id)).log_no).toMatch(/^SL-\d{6}-\d{3}$/);
    expect(await db.rpc(staff, "aal1", "merge_service_entry", [v.id, id])).toMatchObject({ ok: false });
    const r = await db.rpc(owner, "aal2", "merge_service_entry", [v.id, id]);
    expect(r).toMatchObject({ ok: true, id: v.id, log_no: (await row(v.id)).log_no });
    expect(await row(id)).toMatchObject({ log_no: null, merged_into: v.id });
  });

  it("works on approved entries, and a waiting line under an approved sale is approved with it", async () => {
    const v = await visit();
    const id = await loose(v.id);
    expect(await db.rpc(owner, "aal2", "decide_service_log", [v.id, true, null])).toMatchObject({ ok: true });
    expect(await db.rpc(owner, "aal2", "merge_service_entry", [v.id, id])).toMatchObject({ ok: true });
    expect(await row(id)).toMatchObject({ state: "APPROVED", merged_into: v.id });
    expect(await db.rpc(owner, "aal2", "separate_service_entry", [id])).toMatchObject({ ok: true });
    expect(await db.rpc(owner, "aal2", "merge_service_entry", [v.id, id])).toMatchObject({ ok: true });
  });

  it("only the same client, day and branch; never into a meds line or a rejected entry", async () => {
    const v = await visit("DEMO Client A");
    const w = await visit("DEMO Client B");
    const id = await loose(v.id);
    expect(await db.rpc(owner, "aal2", "merge_service_entry", [w.id, id])).toMatchObject({ ok: false, error: "NOT_SAME_VISIT" });
    expect(await db.rpc(owner, "aal2", "merge_service_entry", [id, v.id])).toMatchObject({ ok: false, error: "MAIN_IS_MEDS" });
    const x = await visit("  demo   client a ");
    expect(await db.rpc(owner, "aal2", "merge_service_entry", [x.id, id])).toMatchObject({ ok: true });
    expect(await db.rpc(owner, "aal2", "void_service_entry", [x.id, "DEMO logged twice"])).toMatchObject({ ok: true });
    const y = await loose(v.id);
    expect(await db.rpc(owner, "aal2", "merge_service_entry", [x.id, y])).toMatchObject({ ok: false, error: "REJECTED" });
  });

  it("monthly re-numbering skips merged lines", async () => {
    const v = await visit();
    const m = await db.rpc(staff, "aal1", "log_meds", [v.id, pack, false]);
    const org = (await db.sql(`SELECT organization_id FROM public.service_logs WHERE id = $1`, [v.id])).rows[0].organization_id;
    await db.sql(`SELECT private.renumber_month($1, $2::date)`, [org, today()]);
    expect(await row(m.id)).toMatchObject({ log_no: null, merged_into: v.id });
    expect((await row(v.id)).log_no).toMatch(/^SL-\d{6}-\d{3}$/);
    const nums = (await db.sql(`SELECT count(*)::int n, count(DISTINCT log_no)::int d FROM public.service_logs WHERE log_no IS NOT NULL`)).rows[0];
    expect(nums.n).toBe(nums.d);
  });

  it("two services of one visit with one waiver: the second stops waiting for photos once merged", async () => {
    const v = await visit("DEMO Two Services");
    const second = await db.rpc(owner, "aal2", "log_client_visit", [db.branches.FAIRVIEW, today(), svc, 900000, "SOLO", ana, null, null,
      "PAID", true, "DEMO Two Services", null, randomUUID(), "[]", false]);
    expect(second, JSON.stringify(second)).toMatchObject({ ok: true });
    await db.sql(`SELECT set_config('hermosa.photo_sharing', 'on', false); UPDATE public.service_logs SET photos_due = true WHERE id = '${second.id}'; SELECT set_config('hermosa.photo_sharing', 'off', false);`);
    expect(await db.rpc(owner, "aal2", "merge_service_entry", [v.id, second.id])).toMatchObject({ ok: true });
    expect((await db.sql(`SELECT photos_due, log_no, merged_into FROM public.service_logs WHERE id = $1`, [second.id])).rows[0])
      .toMatchObject({ photos_due: false, log_no: null, merged_into: v.id });
  });
});
