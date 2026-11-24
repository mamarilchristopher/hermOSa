// Tardiness incident reports (0023). All people are DEMO fixtures.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, gm: Person, ana: Person, bea: Person;
let anaE: string, FV: string;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const cutStart = (d: string) => (Number(d.slice(8)) <= 15 ? `${d.slice(0, 8)}01` : `${d.slice(0, 8)}16`);

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

describe("tardiness IR", () => {
  it("drafts an IR when late minutes in the cutoff reach the limit, hidden from the employee until issued", async () => {
    const s = cutStart(today());
    await lateDay(s, "10:00", "10:25");
    expect((await db.sql("SELECT count(*)::int n FROM public.incident_reports")).rows[0].n).toBe(0);
    await lateDay(addDays(s, 1), "10:00", "10:40"); // 65 minutes total, limit 60
    const ir = (await db.sql("SELECT * FROM public.incident_reports")).rows[0];
    expect(ir).toMatchObject({ late_minutes: 65, late_days: 2, state: "DRAFT", ir_no: 1, limit_minutes: 60 });
    expect((await db.sql("SELECT count(*)::int n FROM public.notifications WHERE kind = 'IR_DRAFT'")).rows[0].n).toBeGreaterThan(0);
    expect((await db.as(ana, "aal1", "SELECT count(*)::int n FROM public.incident_reports")).rows[0].n).toBe(0);
    // A later late day updates the draft.
    await lateDay(addDays(s, 2), "10:00", "10:05");
    expect((await db.sql("SELECT late_minutes FROM public.incident_reports")).rows[0].late_minutes).toBe(70);
    const list = await db.rpc(gm, "aal1", "incident_list", []);
    expect(list.reports[0]).toMatchObject({ name: "DEMO Ana", can_manage: true, late_days: 3 });
  });

  it("issue, explain, close; only the right people at each step", async () => {
    const id = (await db.sql("SELECT id FROM public.incident_reports")).rows[0].id;
    expect((await db.rpc(bea, "aal1", "issue_ir", [id, true, null])).ok).toBe(false);
    expect((await db.rpc(ana, "aal1", "explain_ir", [id, "Traffic"])).ok).toBe(false); // not issued yet
    expect((await db.rpc(gm, "aal1", "issue_ir", [id, true, "Please explain"])).ok).toBe(true);
    expect((await db.as(ana, "aal1", "SELECT count(*)::int n FROM public.incident_reports")).rows[0].n).toBe(1);
    expect((await db.as(bea, "aal1", "SELECT count(*)::int n FROM public.incident_reports")).rows[0].n).toBe(0);
    expect((await db.rpc(ana, "aal1", "incident_list", [])).reports[0]).toMatchObject({ mine: true, can_manage: false });
    expect((await db.rpc(ana, "aal1", "explain_ir", [id, "Heavy traffic on EDSA"])).ok).toBe(true);
    expect((await db.rpc(ana, "aal1", "close_ir", [id, "Verbal warning"])).ok).toBe(false);
    expect((await db.rpc(gm, "aal1", "close_ir", [id, "Verbal warning"])).ok).toBe(true);
    expect((await db.sql("SELECT state, action_taken FROM public.incident_reports WHERE id = $1", [id])).rows[0]).toMatchObject({ state: "CLOSED", action_taken: "Verbal warning" });
  });

  it("only owners change the limit", async () => {
    expect((await db.rpc(gm, "aal1", "set_ir_late_limit", [30])).ok).toBe(false);
    expect((await db.rpc(owner, "aal2", "set_ir_late_limit", [30])).ok).toBe(true);
    expect((await db.sql("SELECT ir_late_minutes FROM public.organizations")).rows[0].ir_late_minutes).toBe(30);
  });
});
