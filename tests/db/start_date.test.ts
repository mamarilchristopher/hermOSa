// update-0033: owners and the General Manager override a staff start date; others can't. All data is DEMO.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, gm: Person, fvManager: Person, emp: string;

beforeAll(async () => {
  db = await TestDb.create();
  owner = await db.person("Owner", [["OWNER", null]]);
  gm = await db.person("General Manager", [["MANAGER", null]]);
  fvManager = await db.person("Fairview Manager", [["MANAGER", "FAIRVIEW"]]);
  const { rows } = await db.sql(
    "INSERT INTO public.employees (organization_id, branch_id, full_name, created_by) SELECT organization_id, id, 'DEMO Staff', $2 FROM public.branches WHERE id = $1 RETURNING id",
    [db.branches.FAIRVIEW, owner.appUserId]);
  emp = rows[0].id;
}, 60_000);
afterAll(async () => db?.close());

const hire = async () => (await db.sql("SELECT hire_date::text AS d FROM public.employees WHERE id = $1", [emp])).rows[0].d;

describe("Start date override", () => {
  it("lets an owner set it and logs the change", async () => {
    expect((await db.rpc(owner, "aal2", "set_employee_start_date", [emp, "2024-07-01"])).ok).toBe(true);
    expect(await hire()).toBe("2024-07-01");
    expect(await db.auditCount("START_DATE_SET")).toBe(1);
  });
  it("lets the General Manager change it", async () => {
    expect((await db.rpc(gm, "aal1", "set_employee_start_date", [emp, "2024-08-15"])).ok).toBe(true);
    expect(await hire()).toBe("2024-08-15");
  });
  it("refuses a branch manager", async () => {
    expect((await db.rpc(fvManager, "aal1", "set_employee_start_date", [emp, "2020-01-01"])).ok).toBe(false);
    expect(await hire()).toBe("2024-08-15");
  });
  it("refuses an impossible date", async () => {
    expect((await db.rpc(owner, "aal2", "set_employee_start_date", [emp, "1990-01-01"])).error).toBe("BAD_START_DATE");
  });
});
