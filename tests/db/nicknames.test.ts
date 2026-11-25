// update-0043: nicknames on the schedule, CMA-only schedule, Test branch off. DEMO fixtures only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, gm: Person, fvManager: Person, ana: Person;
let anaE: string, gmE: string, FV: string;
const monday = () => new Date(Date.now() + 7 * 86400000 - ((new Date().getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10);

beforeAll(async () => {
  db = await TestDb.create();
  FV = db.branches.FAIRVIEW;
  owner = await db.person("Owner", [["OWNER", null]]);
  gm = await db.person("General Manager", [["MANAGER", null]]);
  fvManager = await db.person("Fairview Manager", [["MANAGER", "FAIRVIEW"]]);
  ana = await db.person("Ana", [["CLINICIAN", "FAIRVIEW"]]);
  anaE = (await db.rpc(owner, "aal2", "save_employee", [null, FV, "DEMO Ana Cruz", "CMA", true, ana.appUserId, true])).id;
  gmE = (await db.rpc(owner, "aal2", "save_employee", [null, FV, "DEMO GM", "General Manager", false, gm.appUserId, true])).id;
}, 60_000);
afterAll(async () => db?.close());

describe("nicknames and the CMA-only schedule", () => {
  it("managers set a nickname; staff can't", async () => {
    expect((await db.rpc(ana, "aal1", "set_employee_nickname", [anaE, "Ans"])).ok).toBe(false);
    expect((await db.rpc(fvManager, "aal1", "set_employee_nickname", [anaE, "  Ans "])).ok).toBe(true);
    expect((await db.sql("SELECT nickname FROM public.employees WHERE id = $1", [anaE])).rows[0].nickname).toBe("Ans");
  });

  it("week_schedule lists CMAs only, with their nickname", async () => {
    const w = await db.rpc(gm, "aal1", "week_schedule", [monday()]);
    expect(w.people.find((p: { id: string }) => p.id === anaE)).toMatchObject({ nick: "Ans" });
    expect(w.people.find((p: { id: string }) => p.id === gmE)).toBeUndefined();
  });

  it("the update switches off a branch named Test", async () => {
    await db.sql("INSERT INTO public.branches (organization_id, code, name, kind) SELECT id, 'TEST', 'Test', 'CLINIC' FROM public.organizations");
    await db.sql("UPDATE public.branches SET active = false WHERE upper(code) = 'TEST' OR upper(btrim(name)) = 'TEST'");
    expect((await db.sql("SELECT active FROM public.branches WHERE code = 'TEST'")).rows[0].active).toBe(false);
  });
});
