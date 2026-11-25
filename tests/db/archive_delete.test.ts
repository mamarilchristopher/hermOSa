// update-0057: everyone views the client folders; only owners and the GM delete one. DEMO fixtures only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, gm: Person, staff: Person, branchMgr: Person;
let ana: string, svc: string;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());

beforeAll(async () => {
  db = await TestDb.create();
  owner = await db.person("Owner", [["OWNER", null]]);
  gm = await db.person("General Manager", [["MANAGER", null]]);
  staff = await db.person("Fairview Staff", [["CLINICIAN", "FAIRVIEW"]]);
  branchMgr = await db.person("Fairview Manager", [["MANAGER", "FAIRVIEW"]]);
  ana = (await db.rpc(owner, "aal2", "save_employee", [null, db.branches.FAIRVIEW, "DEMO Ana", "CMA", true, staff.appUserId, true])).id;
  svc = (await db.rpc(owner, "aal2", "save_service", [null, "DEMO Test", 10000, 500, true])).id;
}, 60_000);
afterAll(async () => db?.close());

const visit = async () => {
  const folder = randomUUID();
  const list = ["WAIVER", "WAIVER", "BEFORE", "AFTER"].map((k) => {
    const id = randomUUID();
    return { kind: k, path: `${db.branches.FAIRVIEW}/${folder}/${k.toLowerCase()}-${id}.jpg`, thumb: `${db.branches.FAIRVIEW}/${folder}/thumb-${id}.jpg` };
  });
  const r = await db.rpc(staff, "aal1", "log_client_visit", [db.branches.FAIRVIEW, today(), svc, 10000, "SOLO", ana, null, null,
    "PAID", true, "DEMO Test Client", null, folder, JSON.stringify(list), false]);
  expect(r.ok).toBe(true);
  return r.id as string;
};
const count = async (t: string, col: string, id: string) => (await db.sql(`SELECT count(*)::int n FROM public.${t} WHERE ${col} = $1`, [id])).rows[0].n;

describe("delete_client_visit", () => {
  it("staff and branch managers can't delete; the entry stays", async () => {
    const id = await visit();
    expect((await db.rpc(staff, "aal1", "delete_client_visit", [id])).error).toBe("NOT_ALLOWED");
    expect((await db.rpc(branchMgr, "aal1", "delete_client_visit", [id])).error).toBe("NOT_ALLOWED");
    expect(await count("service_logs", "id", id)).toBe(1);
  });

  it("the GM deletes the visit, its photos and commission lines, and gets the 8 files back", async () => {
    const id = await visit();
    const r = await db.rpc(gm, "aal1", "delete_client_visit", [id]);
    expect(r.ok).toBe(true);
    expect(r.paths.length).toBe(8);
    expect(await count("service_logs", "id", id)).toBe(0);
    expect(await count("service_photos", "service_log_id", id)).toBe(0);
    expect(await count("commission_lines", "service_log_id", id)).toBe(0);
    expect((await db.rpc(owner, "aal2", "delete_client_visit", [id])).error).toBe("NOT_FOUND");
  });

  it("an owner can delete an approved entry; direct deletes stay blocked", async () => {
    const id = await visit();
    expect((await db.rpc(gm, "aal1", "decide_service_log", [id, true, null])).state).toBe("APPROVED");
    await expect(db.sql("DELETE FROM public.service_logs WHERE id = $1", [id])).rejects.toThrow(/SERVICE_LOGS_ARE_NOT_DELETED|violates foreign key/);
    expect((await db.rpc(owner, "aal2", "delete_client_visit", [id])).ok).toBe(true);
  });
});
