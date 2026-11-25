// Employee details: staff submit, the owner or the General Manager approves, sensitive data stays private. DEMO fixtures only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, gm: Person, manager: Person, cma: Person, other: Person;
const DEMO = { first_name: "Demo", last_name: "Staffer", birth_date: "1999-01-02", tin: "123456789", hire_date: "2024-03-01", consent: "yes" };

beforeAll(async () => {
  db = await TestDb.create();
  owner = await db.person("Owner", [["OWNER", null]]);
  gm = await db.person("GM", [["MANAGER", null]]);
  manager = await db.person("Branch manager", [["MANAGER", "FAIRVIEW"]]);
  cma = await db.person("Cma", [["CLINICIAN", "FAIRVIEW"]]);
  other = await db.person("Other", [["CLINICIAN", "FAIRVIEW"]]);
  for (const p of [cma, other, gm]) {
    await db.sql(`INSERT INTO public.employees (organization_id, branch_id, full_name, app_user_id, created_by)
                  VALUES ('00000000-0000-4000-8000-000000000001', $1, $2, $3, $4)`, [db.branches.FAIRVIEW, `DEMO ${p.name}`, p.appUserId, owner.appUserId]);
  }
}, 60_000);
afterAll(async () => db?.close());

let sub = "";

describe("employee details", () => {
  it("needs a name and the consent tick", async () => {
    expect((await db.rpc(cma, "aal1", "submit_employee_details", [JSON.stringify({ first_name: "Demo" })])).error).toBe("BAD_REQUEST");
    expect((await db.rpc(cma, "aal1", "submit_employee_details", [JSON.stringify({ ...DEMO, consent: "" })])).error).toBe("BAD_REQUEST");
  });

  it("a newer copy replaces the one still waiting", async () => {
    expect((await db.rpc(cma, "aal1", "submit_employee_details", [JSON.stringify(DEMO)])).ok).toBe(true);
    const r = await db.rpc(cma, "aal1", "submit_employee_details", [JSON.stringify({ ...DEMO, nickname: "Dem" })]);
    sub = r.id;
    const { rows } = await db.sql("SELECT state FROM public.employee_detail_submissions WHERE user_id = $1 ORDER BY submitted_at", [cma.appUserId]);
    expect(rows.map((x) => x.state)).toEqual(["SUPERSEDED", "PENDING"]);
  });

  it("only the person, owners and the GM read submissions; branch managers and coworkers can't", async () => {
    expect((await db.as(cma, "aal1", "SELECT data->>'tin' AS t FROM public.employee_detail_submissions WHERE state = 'PENDING'")).rows).toEqual([{ t: "123456789" }]);
    expect((await db.as(other, "aal1", "SELECT 1 FROM public.employee_detail_submissions")).rows).toHaveLength(0);
    expect((await db.as(manager, "aal2", "SELECT 1 FROM public.employee_detail_submissions")).rows).toHaveLength(0);
    expect((await db.as(owner, "aal2", "SELECT 1 FROM public.employee_detail_submissions WHERE state = 'PENDING'")).rows).toHaveLength(1);
    expect((await db.as(owner, "aal1", "SELECT 1 FROM public.employee_detail_submissions")).rows).toHaveLength(0);
    expect((await db.as(gm, "aal1", "SELECT 1 FROM public.employee_detail_submissions WHERE state = 'PENDING'")).rows).toHaveLength(1);
  });

  it("only an MFA owner or the GM decides, and sending back needs a note", async () => {
    expect((await db.rpc(manager, "aal2", "decide_employee_details", [sub, true, null, "DEMO Name", null])).error).toBe("FORBIDDEN");
    expect((await db.rpc(owner, "aal1", "decide_employee_details", [sub, true, null, "DEMO Name", null])).error).toBe("MFA_REQUIRED");
    expect((await db.rpc(owner, "aal2", "decide_employee_details", [sub, false, null, null, ""])).error).toBe("NOTE_REQUIRED");
    expect((await db.rpc(gm, "aal1", "decide_employee_details", [sub, false, null, null, ""])).error).toBe("NOTE_REQUIRED");
  });

  it("the GM approves other people's details, but an owner approves the GM's own", async () => {
    const mine = await db.rpc(gm, "aal1", "submit_employee_details", [JSON.stringify({ ...DEMO, first_name: "Gm" })]);
    expect((await db.rpc(gm, "aal1", "decide_employee_details", [mine.id, true, null, "DEMO GM", null])).error).toBe("SELF_APPROVAL_DENIED");
    expect((await db.rpc(owner, "aal2", "decide_employee_details", [mine.id, true, null, "DEMO GM", null])).ok).toBe(true);
  });

  it("approving with a correction applies it to the employee record", async () => {
    const fixed = { ...DEMO, nickname: "Dem", hire_date: "2024-02-15" };
    const r = await db.rpc(gm, "aal1", "decide_employee_details", [sub, true, JSON.stringify(fixed), "Demo Staffer", null]);
    expect(r.ok).toBe(true);
    const { rows } = await db.sql("SELECT full_name, hire_date::text AS h FROM public.employees WHERE app_user_id = $1", [cma.appUserId]);
    expect(rows[0]).toEqual({ full_name: "Demo Staffer", h: "2024-02-15" });
    expect((await db.as(cma, "aal1", "SELECT data->>'hire_date' AS h FROM public.employee_details")).rows).toEqual([{ h: "2024-02-15" }]);
    expect((await db.as(other, "aal1", "SELECT 1 FROM public.employee_details")).rows).toHaveLength(0);
    expect((await db.as(manager, "aal2", "SELECT 1 FROM public.employee_details")).rows).toHaveLength(0);
    expect((await db.rpc(owner, "aal2", "decide_employee_details", [sub, true, null, "Demo Staffer", null])).error).toBe("NOT_PENDING");
    const { rows: a } = await db.sql("SELECT next_value::text AS v FROM public.audit_events WHERE action = 'DETAILS_APPROVED'");
    expect(a[0].v).not.toContain("123456789");
  });

  it("someone not yet approved as staff can send details but they can't be applied yet", async () => {
    const { rows } = await db.sql("INSERT INTO auth.users (email, raw_user_meta_data) VALUES ('wait@demo.invalid', '{\"full_name\":\"DEMO Waiting\"}') RETURNING id");
    const { rows: u } = await db.sql("SELECT id FROM public.app_users WHERE auth_subject = $1", [rows[0].id]);
    const waiting: Person = { appUserId: u[0].id, authSubject: rows[0].id, name: "waiting" };
    const r = await db.rpc(waiting, "aal1", "submit_employee_details", [JSON.stringify(DEMO)]);
    expect(r.ok).toBe(true);
    expect((await db.rpc(owner, "aal2", "decide_employee_details", [r.id, true, null, "Demo Waiting", null])).error).toBe("NO_EMPLOYEE_RECORD");
  });
});
