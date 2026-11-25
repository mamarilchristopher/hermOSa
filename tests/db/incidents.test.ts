// Tardiness: Late NTEs (0029) and the IRs issued from them. All people are DEMO fixtures.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, gm: Person, ana: Person, bea: Person;
let anaE: string, FV: string;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const monthStart = (d: string) => `${d.slice(0, 8)}01`;

beforeAll(async () => {
  db = await TestDb.create();
  FV = db.branches.FAIRVIEW;
  owner = await db.person("Owner", [["OWNER", null]]);
  gm = await db.person("General Manager", [["MANAGER", null]]);
  ana = await db.person("Ana", [["CLINICIAN", "FAIRVIEW"]]);
  bea = await db.person("Bea", [["CLINICIAN", "FAIRVIEW"]]);
  anaE = (await db.rpc(owner, "aal2", "save_employee", [null, FV, "DEMO Ana", "CMA", true, ana.appUserId, true])).id;
  await db.rpc(owner, "aal2", "save_employee", [null, FV, "DEMO Bea", "CMA", true, bea.appUserId, true]);
}, 60_000);
afterAll(async () => db?.close());

// A published shift starting at `start` on day d, and a time-in at `inAt` (Manila time) inserted directly.
async function lateDay(d: string, start: string, inAt: string) {
  await db.sql(`INSERT INTO public.shifts (organization_id, employee_id, work_date, branch_id, start_time, end_time, state, updated_by)
    SELECT organization_id, id, $2, $3, $4, '19:00', 'PUBLISHED', $5 FROM public.employees WHERE id = $1
    ON CONFLICT (employee_id, work_date) DO NOTHING`, [anaE, d, FV, start, gm.appUserId]);
  await db.sql(`INSERT INTO public.time_punches (organization_id, employee_id, user_id, branch_id, kind, punched_at, work_date, photo_path)
    SELECT organization_id, id, $2, $3, 'IN', ($4 || ' ' || $5)::timestamp AT TIME ZONE 'Asia/Manila', $4::date, NULL FROM public.employees WHERE id = $1`,
    [anaE, ana.appUserId, FV, d, inAt]);
}

describe("Late NTEs and IRs", () => {
  let ntes: string[] = [];
  it("a time-in more than 15 minutes late makes a Late NTE; 15 minutes or less doesn't", async () => {
    const m = monthStart(today());
    await lateDay(m, "10:00", "10:15");
    expect((await db.sql("SELECT count(*)::int n FROM public.late_ntes")).rows[0].n).toBe(0);
    await lateDay(addDays(m, 1), "10:00", "10:16");
    await lateDay(addDays(m, 2), "10:00", "10:40");
    const rows = (await db.sql("SELECT id, late_minutes, state, nte_no FROM public.late_ntes ORDER BY work_date")).rows;
    expect(rows.map((r) => [r.late_minutes, r.state, r.nte_no])).toEqual([[16, "OPEN", 1], [40, "OPEN", 2]]);
    ntes = rows.map((r) => r.id);
    expect((await db.sql("SELECT count(*)::int n FROM public.notifications WHERE kind = 'NTE_LATE'")).rows[0].n).toBe(2);
    expect((await db.sql("SELECT count(*)::int n FROM public.incident_reports")).rows[0].n).toBe(0); // no automatic IR drafts any more
  });

  it("the employee sees and explains their own; coworkers see nothing", async () => {
    expect((await db.as(ana, "aal1", "SELECT count(*)::int n FROM public.late_ntes")).rows[0].n).toBe(2);
    expect((await db.as(bea, "aal1", "SELECT count(*)::int n FROM public.late_ntes")).rows[0].n).toBe(0);
    expect((await db.rpc(bea, "aal1", "explain_nte", [ntes[0], "Not mine"])).ok).toBe(false);
    expect((await db.rpc(ana, "aal1", "explain_nte", [ntes[0], ""])).error).toBe("REASON_REQUIRED");
    expect((await db.rpc(ana, "aal1", "explain_nte", [ntes[0], "Heavy traffic on EDSA"])).ok).toBe(true);
    expect((await db.rpc(ana, "aal1", "explain_nte", [ntes[0], "Again"])).error).toBe("NOT_PENDING");
  });

  it("the tracker counts this month's NTEs per person for management", async () => {
    const list = await db.rpc(gm, "aal1", "late_nte_list", [today(), null]);
    expect(list.grace).toBe(15);
    expect(list.ntes).toHaveLength(2);
    expect(list.ntes[0]).toMatchObject({ name: "DEMO Ana", can_manage: true });
    expect((await db.rpc(bea, "aal1", "late_nte_list", [today(), null])).ntes).toHaveLength(0);
  });

  it("management voids a mistaken NTE with a reason", async () => {
    expect((await db.rpc(bea, "aal1", "void_nte", [ntes[1], "Wrong schedule"])).ok).toBe(false);
    expect((await db.rpc(gm, "aal1", "void_nte", [ntes[1], ""])).error).toBe("REASON_REQUIRED");
    await lateDay(addDays(monthStart(today()), 3), "10:00", "10:30");
    const third = (await db.sql("SELECT id FROM public.late_ntes WHERE state = 'OPEN' ORDER BY work_date DESC LIMIT 1")).rows[0].id;
    expect((await db.rpc(gm, "aal1", "void_nte", [third, "Approved errand"])).ok).toBe(true);
  });

  it("an IR is issued from the NTEs, acknowledged with a response, then closed", async () => {
    expect((await db.rpc(bea, "aal1", "issue_late_ir", [anaE, today(), null])).ok).toBe(false);
    const r = await db.rpc(gm, "aal1", "issue_late_ir", [anaE, today(), "Please improve"]);
    expect(r.ok).toBe(true);
    const ir = (await db.sql("SELECT * FROM public.incident_reports WHERE id = $1", [r.id])).rows[0];
    expect(ir).toMatchObject({ state: "ISSUED", basis: "LATE_NTE", late_days: 2, late_minutes: 56 });
    expect((await db.sql("SELECT count(*)::int n FROM public.late_ntes WHERE ir_id = $1", [r.id])).rows[0].n).toBe(2);
    expect((await db.rpc(gm, "aal1", "issue_late_ir", [anaE, today(), null])).error).toBe("NOTHING_TO_ISSUE");
    expect((await db.rpc(bea, "aal1", "acknowledge_ir", [r.id, "Ok"])).ok).toBe(false);
    expect((await db.rpc(ana, "aal1", "acknowledge_ir", [r.id, "I understand and will leave earlier."])).ok).toBe(true);
    expect((await db.sql("SELECT state, acknowledged_at IS NOT NULL AS ack FROM public.incident_reports WHERE id = $1", [r.id])).rows[0]).toEqual({ state: "EXPLAINED", ack: true });
    expect((await db.rpc(ana, "aal1", "close_ir", [r.id, "Verbal warning"])).ok).toBe(false);
    expect((await db.rpc(gm, "aal1", "close_ir", [r.id, "Verbal warning"])).ok).toBe(true);
    expect((await db.rpc(bea, "aal1", "mark_ir_pdf", [r.id])).ok).toBe(false);
    expect((await db.rpc(gm, "aal1", "mark_ir_pdf", [r.id])).ok).toBe(true);
  });
});
