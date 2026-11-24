// Schedule rules for "Suggest a week" (0025). DEMO fixtures only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, gm: Person, mk: Person;
beforeAll(async () => {
  db = await TestDb.create();
  owner = await db.person("Owner", [["OWNER", null]]);
  gm = await db.person("General Manager", [["MANAGER", null]]);
  mk = await db.person("Marikina Manager", [["MANAGER", "MARIKINA"]]);
}, 60_000);
afterAll(async () => db?.close());

describe("schedule rules", () => {
  it("owners and the GM save them; branch managers and bad input can't", async () => {
    expect(await db.rpc(gm, "aal1", "schedule_rules", [])).toEqual({});
    expect((await db.rpc(gm, "aal1", "save_schedule_rules", [JSON.stringify({ days_off: 1, min: {} })])).ok).toBe(true);
    expect((await db.rpc(owner, "aal2", "save_schedule_rules", [JSON.stringify({ days_off: 2 })])).ok).toBe(true);
    expect((await db.rpc(mk, "aal1", "save_schedule_rules", [JSON.stringify({ days_off: 1 })])).ok).toBe(false);
    expect((await db.rpc(owner, "aal2", "save_schedule_rules", [JSON.stringify({ days_off: 7 })])).ok).toBe(false);
    expect((await db.rpc(mk, "aal1", "schedule_rules", [])).days_off).toBe(2);
  });
});
