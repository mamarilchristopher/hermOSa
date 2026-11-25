// update-0032: a Late NTE must be explained within 2 scheduled working days (counting the late day), or an IR is issued automatically.
// All people are DEMO fixtures.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, gm: Person, ana: Person, bea: Person;
let anaE: string, beaE: string, FV: string;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

beforeAll(async () => {
  db = await TestDb.create();
  FV = db.branches.FAIRVIEW;
  owner = await db.person("Owner", [["OWNER", null]]);
  gm = await db.person("General Manager", [["MANAGER", null]]);
  ana = await db.person("Ana", [["CLINICIAN", "FAIRVIEW"]]);
  bea = await db.person("Bea", [["CLINICIAN", "FAIRVIEW"]]);
  anaE = (await db.rpc(owner, "aal2", "save_employee", [null, FV, "DEMO Ana", "CMA", true, ana.appUserId, true])).id;
  beaE = (await db.rpc(owner, "aal2", "save_employee", [null, FV, "DEMO Bea", "CMA", true, bea.appUserId, true])).id;
}, 60_000);
afterAll(async () => db?.close());

async function shift(emp: string, d: string, off = false) {
  await db.sql(`INSERT INTO public.shifts (organization_id, employee_id, work_date, branch_id, start_time, end_time, is_off, state, updated_by)
    SELECT organization_id, id, $2, CASE WHEN $4 THEN NULL ELSE $3::uuid END, CASE WHEN $4 THEN NULL ELSE '10:00'::time END,
           CASE WHEN $4 THEN NULL ELSE '19:00'::time END, $4, 'PUBLISHED', $5 FROM public.employees WHERE id = $1
    ON CONFLICT (employee_id, work_date) DO NOTHING`, [emp, d, FV, off, gm.appUserId]);
}
async function lateIn(emp: string, user: Person, d: string) {
  await db.sql(`INSERT INTO public.time_punches (organization_id, employee_id, user_id, branch_id, kind, punched_at, work_date, photo_path)
    SELECT organization_id, id, $2, $3, 'IN', ($4 || ' 10:40')::timestamp AT TIME ZONE 'Asia/Manila', $4::date, NULL FROM public.employees WHERE id = $1`,
    [emp, user.appUserId, FV, d]);
  return (await db.sql("SELECT * FROM public.late_ntes WHERE employee_id = $1 AND work_date = $2", [emp, d])).rows[0];
}

describe("Late NTE deadline", () => {
  // Past days: publish the next working day only after the time-in, as the schedule would be in real life a few days ahead.
  it("the deadline is the next scheduled working day; days off don't count", async () => {
    const d = addDays(today(), -6);
    await shift(anaE, d);
    const n = await lateIn(anaE, ana, d);
    expect(n.respond_by).toBeNull(); // next working day not published yet
    expect((await db.sql("SELECT body FROM public.notifications WHERE kind = 'NTE_LATE' AND user_id = $1", [ana.appUserId])).rows[0].body)
      .toContain("Explain by the end of your next working day, or an IR is issued automatically.");
    await shift(anaE, addDays(d, 1), true); await shift(anaE, addDays(d, 2));
  });

  it("not explained by then: an IR is issued automatically, urgent for the employee, and management is told", async () => {
    const r = await db.rpc(bea, "aal1", "run_nte_deadlines", []);
    expect(r).toMatchObject({ ok: true, issued: 1 });
    const ir = (await db.sql("SELECT r.*, n.respond_by::text AS by FROM public.incident_reports r JOIN public.late_ntes n ON n.ir_id = r.id WHERE n.employee_id = $1", [anaE])).rows[0];
    expect(ir.by).toBe(addDays(addDays(today(), -6), 2)); // the day off was skipped
    expect(ir).toMatchObject({ state: "ISSUED", basis: "LATE_NTE", issued_by: null, late_days: 1 });
    expect(ir.issue_note).toContain("Issued automatically");
    expect((await db.sql("SELECT title FROM public.notifications WHERE kind = 'IR_ISSUED' AND user_id = $1", [ana.appUserId])).rows[0].title).toBe("URGENT: Incident report issued");
    const mgmt = (await db.sql("SELECT user_id FROM public.notifications WHERE kind = 'IR_AUTO'")).rows.map((x) => x.user_id).sort();
    expect(mgmt).toEqual([owner.appUserId, gm.appUserId].sort());
    expect((await db.rpc(gm, "aal1", "run_nte_deadlines", [])).issued).toBe(0); // only once
    const nte = (await db.sql("SELECT id FROM public.late_ntes WHERE employee_id = $1", [anaE])).rows[0].id;
    expect((await db.rpc(ana, "aal1", "explain_nte", [nte, "DEMO forgot"])).ok).toBe(true); // can still explain; the IR stays
  });

  it("today's late time-in tells the employee the date; explained in time or still waiting means no IR", async () => {
    const d = addDays(today(), -4);
    await shift(beaE, d);
    const n = await lateIn(beaE, bea, d);
    expect((await db.rpc(bea, "aal1", "explain_nte", [n.id, "DEMO traffic"])).ok).toBe(true);
    await db.sql("UPDATE public.late_ntes SET explained_at = ($2 || ' 18:00')::timestamp AT TIME ZONE 'Asia/Manila' WHERE id = $1", [n.id, d]); // explained the same day
    await shift(beaE, addDays(d, 1));
    const t = today();
    await shift(beaE, t); await shift(beaE, addDays(t, 1));
    const waiting = await lateIn(beaE, bea, t);
    expect(waiting.respond_by).not.toBeNull();
    expect((await db.sql("SELECT body FROM public.notifications WHERE kind = 'NTE_LATE' AND user_id = $1 ORDER BY created_at DESC LIMIT 1", [bea.appUserId])).rows[0].body)
      .toMatch(/Explain by the end of \w{3}, \w{3} \d{1,2}, or an IR is issued automatically\./);
    expect((await db.rpc(gm, "aal1", "run_nte_deadlines", [])).issued).toBe(0);
    expect((await db.sql("SELECT count(*)::int n FROM public.late_ntes WHERE ir_id IS NOT NULL AND employee_id = $1", [beaE])).rows[0].n).toBe(0);
  });

  it("explained only after the deadline still gets the IR", async () => {
    const cara = await db.person("Cara", [["CLINICIAN", "FAIRVIEW"]]);
    const caraE = (await db.rpc(owner, "aal2", "save_employee", [null, FV, "DEMO Cara", "CMA", true, cara.appUserId, true])).id;
    const d = addDays(today(), -10);
    await shift(caraE, d);
    const n = await lateIn(caraE, cara, d);
    await shift(caraE, addDays(d, 1));
    await db.sql("UPDATE public.late_ntes SET state = 'EXPLAINED', explanation = 'DEMO late reply', explained_at = now() WHERE id = $1", [n.id]);
    expect((await db.rpc(gm, "aal1", "run_nte_deadlines", [])).issued).toBe(1);
    expect((await db.sql("SELECT ir_id FROM public.late_ntes WHERE id = $1", [n.id])).rows[0].ir_id).not.toBeNull();
  });

  it("the NTE list carries the deadline", async () => {
    const list = await db.rpc(bea, "aal1", "late_nte_list", [today(), null]);
    expect(list.ntes.some((x: { respond_by: string | null }) => x.respond_by)).toBe(true);
  });
});
