// View as (0021). All people are DEMO fixtures.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, gm: Person, fvManager: Person, staff: Person;
let ana: string, svc: string;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());

beforeAll(async () => {
  db = await TestDb.create();
  owner = await db.person("Owner", [["OWNER", null]]);
  gm = await db.person("General Manager", [["MANAGER", null]]);
  fvManager = await db.person("Fairview Manager", [["MANAGER", "FAIRVIEW"]]);
  staff = await db.person("Fairview Staff", [["CLINICIAN", "FAIRVIEW"]]);
  ana = (await db.rpc(owner, "aal2", "save_employee", [null, db.branches.FAIRVIEW, "DEMO Ana", "CMA", true, staff.appUserId, true])).id;
  svc = (await db.rpc(gm, "aal1", "add_service", ["DEMO Facial"])).id;
  await db.rpc(staff, "aal1", "log_service", [db.branches.FAIRVIEW, today(), svc, 200_000, "SOLO", ana, null, null, null]);
}, 60_000);
afterAll(async () => db?.close());

describe("view as", () => {
  it("owners and the general manager see a staff member's to-dos", async () => {
    for (const who of [[owner, "aal2"], [gm, "aal1"]] as const) {
      const r = await db.rpc(who[0], who[1], "view_as", [staff.appUserId]);
      expect(r.ok).toBe(true);
      expect(r.name).toBe("DEMO Ana");
      expect(r.unsigned).toMatchObject({ count: 1, oldest: today(), cents: 10000 });
      expect(r.logged_today).toBe(1);
      expect(r.details_state).toBeNull();
    }
    const people = await db.rpc(gm, "aal1", "view_as_people", []);
    expect(people.map((p: { name: string }) => p.name)).toContain("DEMO Ana");
    expect((await db.sql("SELECT count(*)::int n FROM public.audit_events WHERE action = 'VIEW_AS'")).rows[0].n).toBe(2);
  });

  it("branch managers and staff can't", async () => {
    expect((await db.rpc(fvManager, "aal1", "view_as", [staff.appUserId])).ok).toBe(false);
    expect((await db.rpc(staff, "aal1", "view_as", [gm.appUserId])).ok).toBe(false);
    expect(await db.rpc(staff, "aal1", "view_as_people", [])).toEqual([]);
  });
});
