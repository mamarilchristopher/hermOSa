// Invite links, join requests and approval with a staff level. DEMO fixtures only.
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

async function signUp(email: string, meta: Record<string, string>): Promise<Person> {
  const { rows } = await db.sql("INSERT INTO auth.users (email, raw_user_meta_data) VALUES ($1, $2) RETURNING id", [email, JSON.stringify(meta)]);
  const { rows: u } = await db.sql("SELECT id FROM public.app_users WHERE auth_subject = $1", [rows[0].id]);
  return { appUserId: u[0].id, authSubject: rows[0].id, name: email };
}

let code = "";

describe("invite links", () => {
  it("only an MFA-verified owner can make an invite link", async () => {
    expect((await db.rpc(manager, "aal2", "create_staff_invite", [14])).error).toBe("FORBIDDEN");
    expect((await db.rpc(owner, "aal1", "create_staff_invite", [14])).error).toBe("MFA_REQUIRED");
    const r = await db.rpc(owner, "aal2", "create_staff_invite", [14]);
    expect(r.ok).toBe(true);
    expect(r.code).toMatch(/^[a-z0-9]{12,40}$/);
    code = r.code;
  });

  it("the join page can check a code while signed out", async () => {
    const info = (await db.sql("SELECT public.staff_invite_info($1) AS r", [code])).rows[0].r;
    expect(info.valid).toBe(true);
    expect(info.branches.length).toBeGreaterThan(0);
    expect((await db.sql("SELECT public.staff_invite_info('nope') AS r")).rows[0].r.valid).toBe(false);
    const { rows: g } = await db.sql("SELECT has_function_privilege('anon', 'public.staff_invite_info(text)', 'execute') AS ok");
    expect(g[0].ok).toBe(true);
    const { rows: g2 } = await db.sql("SELECT has_function_privilege('anon', 'public.approve_join_request(uuid,text,uuid,text,boolean)', 'execute') AS ok");
    expect(g2[0].ok).toBe(false);
  });

  it("a sign-up quoting a wrong code is refused outright", async () => {
    await expect(signUp("bad@demo.invalid", { full_name: "DEMO Bad", invite_code: "wrongcode1234" })).rejects.toThrow(/INVITE_INVALID/);
  });
});

describe("join requests", () => {
  let gm: Person, cma: Person, nope: Person;

  it("a sign-up from the link waits as pending with no access", async () => {
    gm = await signUp("gm@demo.invalid", { full_name: "DEMO General Manager", invite_code: code, requested_branch: db.branches.FAIRVIEW });
    const { rows } = await db.sql("SELECT join_status, display_name, requested_branch_id FROM public.app_users WHERE id = $1", [gm.appUserId]);
    expect(rows[0]).toMatchObject({ join_status: "PENDING", display_name: "DEMO General Manager", requested_branch_id: db.branches.FAIRVIEW });
    const me = await db.rpc(gm, "aal1", "my_access", []);
    expect(me.join_status).toBe("PENDING");
    expect(me.grants).toEqual([]);
    expect((await db.sql("SELECT use_count FROM public.staff_invites WHERE code = $1", [code])).rows[0].use_count).toBe(1);
  });

  it("approval needs a staff level and a branch, and only the owner can approve", async () => {
    expect((await db.rpc(manager, "aal2", "approve_join_request", [gm.appUserId, "GM", db.branches.FAIRVIEW, null, null])).error).toBe("FORBIDDEN");
    expect((await db.rpc(owner, "aal2", "approve_join_request", [gm.appUserId, null, db.branches.FAIRVIEW, null, null])).error).toBe("LEVEL_REQUIRED");
    expect((await db.rpc(owner, "aal2", "approve_join_request", [gm.appUserId, "BOSS", db.branches.FAIRVIEW, null, null])).error).toBe("LEVEL_REQUIRED");
    expect((await db.rpc(owner, "aal2", "approve_join_request", [gm.appUserId, "GM", null, null, null])).error).toBe("BRANCH_REQUIRED");
  });

  it("General Manager becomes manager of every branch, with an employee record", async () => {
    const r = await db.rpc(owner, "aal2", "approve_join_request", [gm.appUserId, "GM", db.branches.FAIRVIEW, null, false]);
    expect(r.ok).toBe(true);
    const me = await db.rpc(gm, "aal1", "my_access", []);
    expect(me.join_status).toBe("APPROVED");
    expect(me.grants).toEqual([{ role: "MANAGER", branch_id: null }]);
    const { rows } = await db.sql("SELECT position, commission_eligible, branch_id FROM public.employees WHERE app_user_id = $1", [gm.appUserId]);
    expect(rows[0]).toMatchObject({ position: "General Manager", commission_eligible: false, branch_id: db.branches.FAIRVIEW });
    expect(await db.auditCount("JOIN_APPROVED")).toBe(1);
    expect((await db.rpc(owner, "aal2", "approve_join_request", [gm.appUserId, "GM", db.branches.FAIRVIEW, null, null])).error).toBe("NOT_PENDING");
  });

  it("a CMA is a clinician at one branch and on commission by default", async () => {
    cma = await signUp("cma@demo.invalid", { full_name: "DEMO CMA", invite_code: code });
    expect((await db.rpc(owner, "aal2", "approve_join_request", [cma.appUserId, "SENIOR_CMA", db.branches.MARIKINA, null, null])).ok).toBe(true);
    const me = await db.rpc(cma, "aal1", "my_access", []);
    expect(me.grants).toEqual([{ role: "CLINICIAN", branch_id: db.branches.MARIKINA }]);
    const { rows } = await db.sql("SELECT position, commission_eligible FROM public.employees WHERE app_user_id = $1", [cma.appUserId]);
    expect(rows[0]).toMatchObject({ position: "Senior CMA", commission_eligible: true });
  });

  it("a Trainee is a clinician at one branch, not on commission by default", async () => {
    const t = await signUp("trainee@demo.invalid", { full_name: "DEMO Trainee", invite_code: code });
    expect((await db.rpc(owner, "aal2", "approve_join_request", [t.appUserId, "TRAINEE", db.branches.FAIRVIEW, null, null])).ok).toBe(true);
    expect((await db.rpc(t, "aal1", "my_access", [])).grants).toEqual([{ role: "CLINICIAN", branch_id: db.branches.FAIRVIEW }]);
    const { rows } = await db.sql("SELECT position, commission_eligible FROM public.employees WHERE app_user_id = $1", [t.appUserId]);
    expect(rows[0]).toMatchObject({ position: "Trainee", commission_eligible: false });
  });

  it("a rejected request loses the login and can never be given a role", async () => {
    nope = await signUp("nope@demo.invalid", { full_name: "DEMO Stranger", invite_code: code });
    expect((await db.rpc(owner, "aal2", "reject_join_request", [nope.appUserId])).ok).toBe(true);
    expect(await db.rpc(nope, "aal1", "my_access", [])).toBeNull();
    await expect(db.sql("INSERT INTO public.role_grants (user_id, role_code, branch_id) VALUES ($1, 'CASHIER', $2)", [nope.appUserId, db.branches.QC_MAIN])).rejects.toThrow(/USER_REJECTED/);
  });

  it("the General Manager can see and approve staff join requests, but not owner-level accounts", async () => {
    const s1 = await signUp("staff1@demo.invalid", { full_name: "DEMO Staff One", invite_code: code });
    const s2 = await signUp("staff2@demo.invalid", { full_name: "DEMO Staff Two", invite_code: code });
    const seen = (await db.as(gm, "aal1", "SELECT id FROM public.app_users WHERE join_status = 'PENDING'")).rows.map((r) => r.id);
    expect(seen).toEqual(expect.arrayContaining([s1.appUserId, s2.appUserId]));
    expect(seen).not.toContain(owner.appUserId);
    expect((await db.as(gm, "aal1", "SELECT id FROM public.app_users WHERE id = $1", [owner.appUserId])).rows).toEqual([]);
    expect((await db.as(manager, "aal1", "SELECT id FROM public.app_users WHERE join_status = 'PENDING'")).rows).toEqual([]);
    for (const lvl of ["OWNER", "GM", "FINANCE", "HR"]) {
      expect((await db.rpc(gm, "aal1", "approve_join_request", [s1.appUserId, lvl, db.branches.QC_MAIN, null, null])).error).toBe("OWNER_ONLY_LEVEL");
    }
    expect((await db.rpc(gm, "aal1", "approve_join_request", [s1.appUserId, "CMA", db.branches.QC_MAIN, null, null])).ok).toBe(true);
    const { rows } = await db.sql("SELECT role_code, branch_id FROM public.role_grants WHERE user_id = $1 AND revoked_at IS NULL", [s1.appUserId]);
    expect(rows).toEqual([{ role_code: "CLINICIAN", branch_id: db.branches.QC_MAIN }]);
    expect((await db.rpc(manager, "aal1", "reject_join_request", [s2.appUserId])).error).toBe("FORBIDDEN");
    expect((await db.rpc(gm, "aal1", "reject_join_request", [s2.appUserId])).ok).toBe(true);
  });

  it("a revoked link stops working", async () => {
    const { rows } = await db.sql("SELECT id FROM public.staff_invites WHERE code = $1", [code]);
    expect((await db.rpc(owner, "aal2", "revoke_staff_invite", [rows[0].id])).ok).toBe(true);
    expect((await db.sql("SELECT public.staff_invite_info($1) AS r", [code])).rows[0].r.valid).toBe(false);
    await expect(signUp("late@demo.invalid", { full_name: "DEMO Late", invite_code: code })).rejects.toThrow(/INVITE_INVALID/);
  });
});
