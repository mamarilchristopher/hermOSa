// update-0073: management moves an entry's date; nothing else changes; staff can't. DEMO fixtures only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, gm: Person, staff: Person;
let ana: string, svc: string;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

beforeAll(async () => {
  db = await TestDb.create();
  owner = await db.person("Owner", [["OWNER", null]]);
  gm = await db.person("General Manager", [["MANAGER", null]]);
  staff = await db.person("Fairview Staff", [["CLINICIAN", "FAIRVIEW"]]);
  ana = (await db.rpc(owner, "aal2", "save_employee", [null, db.branches.FAIRVIEW, "DEMO Ana", "CMA", true, staff.appUserId, true])).id;
  svc = (await db.rpc(owner, "aal2", "save_service", [null, "DEMO Facial", 100000, 5000, true])).id;
}, 60_000);
afterAll(async () => db?.close());

describe("change_service_date", () => {
  it("moves an approved entry's date, keeps its commission", async () => {
    const folder = randomUUID();
    const v = await db.rpc(owner, "aal2", "log_client_visit", [db.branches.FAIRVIEW, today(), svc, 100000, "SOLO", ana, null, null,
      "PAID", true, "DEMO Client", null, folder, "[]", false]);
    expect(v).toMatchObject({ ok: true, state: "APPROVED" });
    const y = addDays(today(), -1);
    expect(await db.rpc(staff, "aal1", "change_service_date", [v.id, y])).toMatchObject({ ok: false });
    expect(await db.rpc(gm, "aal1", "change_service_date", [v.id, addDays(today(), 1)])).toMatchObject({ ok: false, error: "INVALID_DATE" });
    expect(await db.rpc(gm, "aal1", "change_service_date", [v.id, y])).toMatchObject({ ok: true });
    const row = (await db.sql("SELECT service_date::text d, state, (SELECT sum(amount_cents)::int FROM public.commission_lines WHERE service_log_id = $1) c FROM public.service_logs WHERE id = $1", [v.id])).rows[0];
    expect(row).toMatchObject({ d: y, state: "APPROVED", c: 5000 });
    // Other edits are still blocked.
    await expect(db.sql("UPDATE public.service_logs SET amount_paid_cents = 1 WHERE id = $1", [v.id])).rejects.toThrow();
  });
});
