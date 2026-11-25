// update-0045: approving a join request links the login to an existing staff record with the same name. DEMO fixtures only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person;
let code: string;

beforeAll(async () => {
  db = await TestDb.create();
  owner = await db.person("Owner", [["OWNER", null]]);
  code = (await db.rpc(owner, "aal2", "create_staff_invite", [14])).code;
}, 60_000);
afterAll(async () => db?.close());

const join = async (email: string, name: string) => {
  const { rows } = await db.sql("INSERT INTO auth.users (email, raw_user_meta_data) VALUES ($1, $2) RETURNING id",
    [email, JSON.stringify({ full_name: name, invite_code: code, requested_branch: db.branches.FAIRVIEW, requested_level: "CMA" })]);
  return (await db.sql("SELECT id FROM public.app_users WHERE auth_subject = $1", [rows[0].id])).rows[0].id as string;
};
const addStaff = async (name: string) => (await db.rpc(owner, "aal2", "save_employee", [null, db.branches.FAIRVIEW, name, "CMA", true, null, true])).id as string;

describe("join approval links existing staff", () => {
  it("name_key ignores middle initials, punctuation and a leading Ma.", async () => {
    const k = async (n: string) => (await db.sql("SELECT private.name_key($1) AS k", [n])).rows[0].k;
    expect(await k("Lea R. Demotestcase")).toBe("lea demotestcase");
    expect(await k("lea  demotestcase")).toBe("lea demotestcase");
    expect(await k("Ma. Lea Demotestcase")).toBe("lea demotestcase");
    expect(await k("Demo")).toBe("demo");
  });

  it("links to the one unlinked record with the same first and last name", async () => {
    const emp = await addStaff("Lea Demotestcase");
    await addStaff("Other Demotestcase"); // same surname, different first name: not touched
    const u = await join("lea@demo.invalid", "Lea R. Demotestcase");
    const r = await db.rpc(owner, "aal2", "approve_join_request", [u, "CMA", db.branches.FAIRVIEW, null, null]);
    expect(r).toMatchObject({ ok: true, employee_id: emp });
    const n = (await db.sql("SELECT count(*)::int AS n FROM public.employees WHERE full_name ILIKE '%demotestcase%'")).rows[0].n;
    expect(n).toBe(2);
  });

  it("creates a new record when two records match (can't tell which)", async () => {
    const a = await addStaff("DEMO Twin Samename");
    const b = await addStaff("DEMO Twin Samename");
    const u = await join("twin@demo.invalid", "DEMO Twin Samename");
    const r = await db.rpc(owner, "aal2", "approve_join_request", [u, "CMA", db.branches.FAIRVIEW, null, null]);
    expect(r.ok).toBe(true);
    expect([a, b]).not.toContain(r.employee_id);
  });
});
