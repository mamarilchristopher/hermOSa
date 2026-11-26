// "Online now" for everyone (update-0037), owners first, with photo paths. All data is DEMO.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, gm: Person, fvManager: Person, cma: Person;

beforeAll(async () => {
  db = await TestDb.create();
  owner = await db.person("Owner", [["OWNER", null]]);
  gm = await db.person("General Manager", [["MANAGER", null]]);
  fvManager = await db.person("Fairview Manager", [["MANAGER", "FAIRVIEW"]]);
  cma = await db.person("Jesel", [["CLINICIAN", "FAIRVIEW"]]);
}, 60_000);
afterAll(async () => db?.close());

describe("online now", () => {
  it("shows others who checked in during the last 2 minutes, to everyone, owners first", async () => {
    expect(await db.rpc(owner, "aal2", "online_now", [])).toEqual([]);
    await db.rpc(cma, "aal1", "touch_presence", []);
    await db.rpc(gm, "aal1", "touch_presence", []);
    await db.rpc(owner, "aal2", "touch_presence", []);
    const names = (r: any[]) => r.map((x) => x.name);
    expect(names(await db.rpc(owner, "aal2", "online_now", []))).toEqual(["DEMO General Manager", "DEMO Jesel"]);
    expect(names(await db.rpc(fvManager, "aal1", "online_now", []))).toEqual(["DEMO Owner", "DEMO General Manager", "DEMO Jesel"]);
    // update-0078: each person's account id, so tapping them opens a chat.
    expect((await db.rpc(fvManager, "aal1", "online_now", []))[0].id).toBe(owner.appUserId);
    await db.sql("UPDATE public.app_users SET photo_path = $2 WHERE id = $1", [owner.appUserId, `${owner.appUserId}/00000000-0000-4000-8000-000000000001.jpg`]);
    const seen = await db.rpc(cma, "aal1", "online_now", []);
    expect(names(seen)).toEqual(["DEMO Owner", "DEMO General Manager"]);
    expect(seen[0]).toMatchObject({ owner: true, photo: `${owner.appUserId}/00000000-0000-4000-8000-000000000001.jpg` });
    expect(seen[1]).toMatchObject({ owner: false, photo: null });
  });

  it("drops people after 2 minutes without a check-in", async () => {
    await db.sql("UPDATE private.user_presence SET last_seen = now() - interval '3 minutes' WHERE user_id = $1", [cma.appUserId]);
    expect((await db.rpc(owner, "aal2", "online_now", [])).map((x: any) => x.name)).toEqual(["DEMO General Manager"]);
  });

  it("shows the approved nickname, else the first name without a Ma. prefix (update-0059)", async () => {
    await db.rpc(cma, "aal1", "touch_presence", []);
    const emp = (await db.rpc(owner, "aal2", "save_employee", [null, db.branches.FAIRVIEW, "Ma. DEMOJ Cruz", "CMA", true, cma.appUserId, true])).id;
    const names = async () => (await db.rpc(owner, "aal2", "online_now", [])).map((x: any) => x.name);
    expect(await names()).toContain("DEMOJ");
    expect((await db.rpc(owner, "aal2", "set_employee_nickname", [emp, "DEMO Jess"])).ok).toBe(true);
    expect(await names()).toContain("DEMO Jess");
  });
});
