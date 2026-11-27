// update-0092 (CHRIS Nov 27): staff are not locked to their home branch. A branch CLINICIAN grant works at
// every open clinic; approvals (MANAGER) stay with their branch. DEMO fixtures only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let otherId = "";
const other0 = () => otherId;
let staff: Person, cashier: Person, manager: Person, owner: Person;

beforeAll(async () => {
  db = await TestDb.create();
  owner = await db.person("Owner", [["OWNER", null]]);
  staff = await db.person("Fairview Staff", [["CLINICIAN", "FAIRVIEW"]]);
  cashier = await db.person("Fairview Cashier", [["CASHIER", "FAIRVIEW"]]);
  manager = await db.person("Fairview Manager", [["MANAGER", "FAIRVIEW"]]);
  otherId = (await db.sql("SELECT id FROM public.branches WHERE kind = 'CLINIC' AND active AND id <> $1 LIMIT 1", [db.branches.FAIRVIEW])).rows[0].id;
}, 60_000);
afterAll(async () => db?.close());

const has = async (who: Person, roles: string[], branch: string | null) =>
  (await db.as(who, "aal1", "SELECT private.has_role($1::text[], $2::uuid) AS ok", [roles, branch])).rows[0].ok;

describe("staff at any branch", () => {
  it("a Fairview CMA can work at every other clinic", async () => {
    const clinics = (await db.sql("SELECT id FROM public.branches WHERE kind = 'CLINIC' AND active")).rows.map((r) => r.id);
    expect(clinics.length).toBeGreaterThan(1);
    for (const b of clinics) {
      expect(await has(staff, ["OWNER", "FINANCE", "MANAGER", "CASHIER", "CLINICIAN"], b)).toBe(true);
    }
  });

  it("but it is still not a company-wide grant, and approvals stay with their branch", async () => {
    expect(await has(staff, ["CLINICIAN"], null)).toBe(false);
    expect(await has(cashier, ["CASHIER"], other0())).toBe(false);
    const other = (await db.sql("SELECT id FROM public.branches WHERE kind = 'CLINIC' AND active AND id <> $1 LIMIT 1", [db.branches.FAIRVIEW])).rows[0].id;
    expect(await has(manager, ["MANAGER"], db.branches.FAIRVIEW)).toBe(true);
    expect(await has(manager, ["MANAGER"], other)).toBe(false);
    expect(await has(staff, ["MANAGER", "OWNER"], other)).toBe(false);
  });

  it("not at switched-off branches", async () => {
    const other = (await db.sql("SELECT id FROM public.branches WHERE kind = 'CLINIC' AND active AND id <> $1 LIMIT 1", [db.branches.FAIRVIEW])).rows[0].id;
    await db.sql("UPDATE public.branches SET active = false WHERE id = $1", [other]);
    expect(await has(staff, ["CLINICIAN"], other)).toBe(false);
    await db.sql("UPDATE public.branches SET active = true WHERE id = $1", [other]);
    expect(owner).toBeTruthy();
  });
});
