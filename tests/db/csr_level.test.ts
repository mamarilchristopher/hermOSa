// update-0038: CSR staff level, WFH branch, CSR time-in. DEMO fixtures only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, gm: Person, csr: Person;
let WFH: string, code: string;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());

beforeAll(async () => {
  db = await TestDb.create();
  // On the live database the update adds WFH itself; the test seed runs after the migrations, so add it here the same way.
  WFH = (await db.sql(`INSERT INTO public.branches (organization_id, code, name, kind) SELECT id, 'WFH', 'WFH', 'WFH' FROM public.organizations
    ON CONFLICT (organization_id, code) DO UPDATE SET kind = 'WFH' RETURNING id`)).rows[0].id;
  owner = await db.person("Owner", [["OWNER", null]]);
  gm = await db.person("General Manager", [["MANAGER", null]]);
  code = (await db.rpc(owner, "aal2", "create_staff_invite", [14])).code;
}, 60_000);
afterAll(async () => db?.close());

describe("CSR level", () => {
  it("registration offers WFH and keeps the role the person picked", async () => {
    const info = (await db.sql("SELECT public.staff_invite_info($1) AS r", [code])).rows[0].r;
    expect(info.branches.map((b: { code: string }) => b.code)).toContain("WFH");
    const { rows } = await db.sql("INSERT INTO auth.users (email, raw_user_meta_data) VALUES ($1, $2) RETURNING id",
      ["csr@demo.invalid", JSON.stringify({ full_name: "DEMO Csr", invite_code: code, requested_branch: WFH, requested_level: "CSR" })]);
    const u = (await db.sql("SELECT id, requested_branch_id, requested_level FROM public.app_users WHERE auth_subject = $1", [rows[0].id])).rows[0];
    expect(u).toMatchObject({ requested_branch_id: WFH, requested_level: "CSR" });
    csr = { appUserId: u.id, authSubject: rows[0].id, name: "DEMO Csr" };
  });

  it("someone can ask to join as Owner; only an owner can grant it", async () => {
    const { rows } = await db.sql("INSERT INTO auth.users (email, raw_user_meta_data) VALUES ($1, $2) RETURNING id",
      ["coowner@demo.invalid", JSON.stringify({ full_name: "DEMO Co-owner", invite_code: code, requested_branch: db.branches.QC_MAIN, requested_level: "OWNER" })]);
    const u = (await db.sql("SELECT id, requested_level FROM public.app_users WHERE auth_subject = $1", [rows[0].id])).rows[0];
    expect(u.requested_level).toBe("OWNER");
    expect((await db.rpc(gm, "aal1", "approve_join_request", [u.id, "OWNER", db.branches.QC_MAIN, null, null])).error).toBe("OWNER_ONLY_LEVEL");
    expect((await db.rpc(owner, "aal2", "approve_join_request", [u.id, "OWNER", db.branches.QC_MAIN, null, false])).ok).toBe(true);
    const g = (await db.sql("SELECT role_code, branch_id FROM public.role_grants WHERE user_id = $1 AND revoked_at IS NULL", [u.id])).rows;
    expect(g).toEqual([{ role_code: "OWNER", branch_id: null }]);
  });

  it("the GM can approve a CSR: all-branch CSR role, WFH home, no commission", async () => {
    const r = await db.rpc(gm, "aal1", "approve_join_request", [csr.appUserId, "CSR", WFH, null, null]);
    expect(r.ok).toBe(true);
    const g = (await db.sql("SELECT role_code, branch_id FROM public.role_grants WHERE user_id = $1", [csr.appUserId])).rows;
    expect(g).toEqual([{ role_code: "CSR", branch_id: null }]);
    const e = (await db.sql("SELECT branch_id, position, commission_eligible FROM public.employees WHERE id = $1", [r.employee_id])).rows[0];
    expect(e).toEqual({ branch_id: WFH, position: "CSR", commission_eligible: false });
  });

  it("CSRs are scheduled at WFH, flagged on the schedule, and time in there without a location", async () => {
    const emp = (await db.sql("SELECT id FROM public.employees WHERE app_user_id = $1", [csr.appUserId])).rows[0].id;
    const d = today();
    expect((await db.rpc(gm, "aal1", "save_shift", [emp, d, false, WFH, "00:00", "23:59", null])).ok).toBe(true);
    await db.sql("UPDATE public.shifts SET state = 'PUBLISHED' WHERE employee_id = $1 AND work_date = $2", [emp, d]);
    const monday = (await db.sql("SELECT date_trunc('week', $1::date)::date::text AS m", [d])).rows[0].m;
    const w = await db.rpc(gm, "aal1", "week_schedule", [monday]);
    expect(w.people.find((p: { id: string }) => p.id === emp)).toMatchObject({ csr: true });
    const photo = `${csr.appUserId}/11111111-1111-4111-8111-111111111111.jpg`;
    const r = await db.rpc(csr, "aal1", "clock_punch", ["IN", WFH, photo, null, null, null]);
    expect(r.ok).toBe(true);
    expect(r.distance_m ?? null).toBeNull();
  });
});
