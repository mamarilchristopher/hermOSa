// New logins and staff management. DEMO fixtures only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, manager: Person;

beforeAll(async () => {
  db = await TestDb.create();
  owner = await db.person("Owner", [["OWNER", null]]);
  manager = await db.person("Manager", [["MANAGER", "QC_MAIN"]]);
}, 60_000);
afterAll(async () => db?.close());

describe("new logins", () => {
  it("a new Supabase login gets an account with no roles and sees nothing", async () => {
    const { rows } = await db.sql(
      "INSERT INTO auth.users (email, raw_user_meta_data) VALUES ('new.staff@demo.invalid', '{\"display_name\":\"DEMO New Staff\"}') RETURNING id",
    );
    const { rows: u } = await db.sql("SELECT id, display_name FROM public.app_users WHERE auth_subject = $1", [rows[0].id]);
    expect(u[0].display_name).toBe("DEMO New Staff");
    const fresh: Person = { appUserId: u[0].id, authSubject: rows[0].id, name: "new" };
    const me = await db.rpc(fresh, "aal1", "my_access", []);
    expect(me.grants).toEqual([]);
    const totals = await db.rpc(fresh, "aal1", "historical_sales_totals", [db.branches.QC_MAIN, "2025-01-01", "2025-12-31"]);
    expect(totals.error).toBe("FORBIDDEN");
  });
});

describe("staff management", () => {
  it("only an MFA-verified owner can rename or deactivate staff", async () => {
    expect((await db.rpc(manager, "aal2", "update_staff_user", [manager.appUserId, "x", true])).error).toBe("FORBIDDEN");
    expect((await db.rpc(owner, "aal1", "update_staff_user", [manager.appUserId, "x", true])).error).toBe("MFA_REQUIRED");
    expect((await db.rpc(owner, "aal2", "update_staff_user", [manager.appUserId, "DEMO QC Manager", true])).ok).toBe(true);
  });

  it("a deactivated login loses all access immediately", async () => {
    expect((await db.rpc(owner, "aal2", "update_staff_user", [manager.appUserId, "DEMO QC Manager", false])).ok).toBe(true);
    const me = await db.rpc(manager, "aal1", "my_access", []);
    expect(me).toBeNull();
    const { rows } = await db.as(manager, "aal1", "SELECT 1 FROM public.branches");
    expect(rows).toHaveLength(0);
  });

  it("the owner cannot deactivate themselves", async () => {
    expect((await db.rpc(owner, "aal2", "update_staff_user", [owner.appUserId, "DEMO Owner", false])).error).toBe("SELF_CHANGE_DENIED");
  });
});
