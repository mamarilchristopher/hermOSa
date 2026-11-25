// update-0044: management (owners and the GM) can tag a day as irregular so lateness that day is ignored. All people are DEMO fixtures.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, gm: Person, ana: Person, bea: Person, lead: Person;
let anaE: string, beaE: string, FV: string;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

beforeAll(async () => {
  db = await TestDb.create();
  FV = db.branches.FAIRVIEW;
  owner = await db.person("Owner", [["OWNER", null]]);
  gm = await db.person("General Manager", [["MANAGER", null]]);
  lead = await db.person("Branch Lead", [["MANAGER", "FAIRVIEW"]]);
  ana = await db.person("Ana", [["CLINICIAN", "FAIRVIEW"]]);
  bea = await db.person("Bea", [["CLINICIAN", "FAIRVIEW"]]);
  anaE = (await db.rpc(owner, "aal2", "save_employee", [null, FV, "DEMO Ana", "CMA", true, ana.appUserId, true])).id;
  beaE = (await db.rpc(owner, "aal2", "save_employee", [null, FV, "DEMO Bea", "CMA", true, bea.appUserId, true])).id;
}, 60_000);
afterAll(async () => db?.close());

async function shift(emp: string, d: string) {
  await db.sql(`INSERT INTO public.shifts (organization_id, employee_id, work_date, branch_id, start_time, end_time, is_off, state, updated_by)
    SELECT organization_id, id, $2, $3, '10:00', '19:00', false, 'PUBLISHED', $4 FROM public.employees WHERE id = $1
    ON CONFLICT (employee_id, work_date) DO NOTHING`, [emp, d, FV, gm.appUserId]);
}
async function lateIn(emp: string, user: Person, d: string) {
  await db.sql(`INSERT INTO public.time_punches (organization_id, employee_id, user_id, branch_id, kind, punched_at, work_date, photo_path)
    SELECT organization_id, id, $2, $3, 'IN', ($4 || ' 10:40')::timestamp AT TIME ZONE 'Asia/Manila', $4::date, NULL FROM public.employees WHERE id = $1`,
    [emp, user.appUserId, FV, d]);
}
const nte = async (emp: string, d: string) => (await db.sql("SELECT * FROM public.late_ntes WHERE employee_id = $1 AND work_date = $2", [emp, d])).rows[0];
const row = (list: { employee_id: string }[], emp: string) => list.find((x) => x.employee_id === emp) as Record<string, unknown>;

describe("irregular days", () => {
  it("only owners and the GM can tag; Other needs a typed reason", async () => {
    const d = today();
    expect((await db.rpc(lead, "aal1", "set_irregular_day", [d, null, "MAINTENANCE", null])).ok).toBe(false);
    expect((await db.rpc(ana, "aal1", "set_irregular_day", [d, anaE, "EMERGENCY", null])).ok).toBe(false);
    expect(await db.rpc(gm, "aal1", "set_irregular_day", [d, null, "OTHER", " "])).toMatchObject({ ok: false, error: "OTHER_REASON_REQUIRED" });
    expect((await db.rpc(gm, "aal1", "set_irregular_day", [d, null, "BOGUS", null])).ok).toBe(false);
  });

  it("tagging one person voids their open Late NTE and clears late minutes; others stay late", async () => {
    const d = addDays(today(), -1);
    await shift(anaE, d); await shift(beaE, d);
    await lateIn(anaE, ana, d); await lateIn(beaE, bea, d);
    expect((await nte(anaE, d)).state).not.toBe("VOID");
    const r = await db.rpc(gm, "aal1", "set_irregular_day", [d, anaE, "EMERGENCY", null]);
    expect(r).toMatchObject({ ok: true, ntes_voided: 1, ntes_with_ir: 0 });
    expect(await nte(anaE, d)).toMatchObject({ state: "VOID", void_reason: "Irregular day: emergency" });
    expect((await nte(beaE, d)).state).not.toBe("VOID");
    const duty = await db.rpc(owner, "aal2", "on_duty", [d]);
    expect(row(duty, anaE)).toMatchObject({ late_min: null, irregular: { reason: "EMERGENCY", whole_day: false } });
    expect(row(duty, beaE)).toMatchObject({ late_min: 25, irregular: null });
    const att = await db.rpc(owner, "aal2", "attendance", [d, d]);
    expect(row(att, anaE)).toMatchObject({ late_days: 0, late_min: 0 });
    expect(row(att, beaE)).toMatchObject({ late_days: 1, late_min: 25 });
    const days = (await db.sql("SELECT private.late_days($1, $2, $2) AS a, private.late_days($3, $2, $2) AS b", [anaE, d, beaE])).rows[0];
    expect(days.a).toEqual([]); expect(days.b).toHaveLength(1);
  });

  it("a whole-day tag covers everyone, stops new Late NTEs, and can be undone", async () => {
    const d = today(); // a past day would already have its auto IR, which a tag leaves alone
    await shift(anaE, d); await shift(beaE, d);
    await lateIn(anaE, ana, d);
    const r = await db.rpc(gm, "aal1", "set_irregular_day", [d, null, "OTHER", "DEMO test time-ins"]);
    expect(r).toMatchObject({ ok: true, ntes_voided: 1 });
    expect((await nte(anaE, d)).void_reason).toBe("Irregular day: other (DEMO test time-ins)");
    await lateIn(beaE, bea, d); // timed in after the tag: no NTE at all
    expect(await nte(beaE, d)).toBeUndefined();
    const duty = await db.rpc(gm, "aal1", "on_duty", [d]);
    expect(row(duty, beaE)).toMatchObject({ late_min: null, irregular: { reason: "OTHER", note: "DEMO test time-ins", whole_day: true } });
    // re-tagging the same day updates it instead of failing
    expect((await db.rpc(gm, "aal1", "set_irregular_day", [d, null, "MAINTENANCE", null])).ok).toBe(true);
    expect((await db.sql("SELECT count(*)::int n FROM public.irregular_days WHERE work_date = $1", [d])).rows[0].n).toBe(1);
    expect((await db.rpc(lead, "aal1", "clear_irregular_day", [r.id])).ok).toBe(false);
    expect((await db.rpc(gm, "aal1", "clear_irregular_day", [r.id])).ok).toBe(true);
    expect(row(await db.rpc(gm, "aal1", "on_duty", [d]), beaE)).toMatchObject({ late_min: 25, irregular: null });
    expect((await nte(anaE, d)).state).toBe("VOID"); // undo doesn't bring voided NTEs back
  });
});
