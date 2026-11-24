// "Online now" for owners and managers. All data is DEMO.
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
  it("shows others who checked in during the last 2 minutes, to owners and managers only", async () => {
    expect(await db.rpc(owner, "aal2", "online_now", [])).toEqual([]);
    await db.rpc(cma, "aal1", "touch_presence", []);
    await db.rpc(gm, "aal1", "touch_presence", []);
    await db.rpc(owner, "aal2", "touch_presence", []);
    const names = (r: any[]) => r.map((x) => x.name);
    expect(names(await db.rpc(owner, "aal2", "online_now", []))).toEqual(["DEMO General Manager", "DEMO Jesel"]);
    expect(names(await db.rpc(fvManager, "aal1", "online_now", []))).toEqual(["DEMO General Manager", "DEMO Jesel", "DEMO Owner"]);
    expect(await db.rpc(cma, "aal1", "online_now", [])).toEqual([]);
  });

  it("drops people after 2 minutes without a check-in", async () => {
    await db.sql("UPDATE private.user_presence SET last_seen = now() - interval '3 minutes' WHERE user_id = $1", [cma.appUserId]);
    expect((await db.rpc(owner, "aal2", "online_now", [])).map((x: any) => x.name)).toEqual(["DEMO General Manager"]);
  });
});
