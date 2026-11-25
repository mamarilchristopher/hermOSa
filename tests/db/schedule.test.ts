// Weekly schedule, swaps, time clock and On Duty (0022). All people are DEMO fixtures.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, gm: Person, mkManager: Person, ana: Person, bea: Person;
let anaE: string, beaE: string, FV: string, MK: string;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const nextMonday = () => { let d = addDays(today(), 1); while (new Date(`${d}T00:00:00Z`).getUTCDay() !== 1) d = addDays(d, 1); return d; };
let monday: string;

beforeAll(async () => {
  db = await TestDb.create();
  FV = db.branches.FAIRVIEW; MK = db.branches.MARIKINA;
  owner = await db.person("Owner", [["OWNER", null]]);
  gm = await db.person("General Manager", [["MANAGER", null]]);
  mkManager = await db.person("Marikina Manager", [["MANAGER", "MARIKINA"]]);
  ana = await db.person("Ana", [["CLINICIAN", "FAIRVIEW"]]);
  bea = await db.person("Bea", [["CLINICIAN", "FAIRVIEW"]]);
  const add = async (name: string, who: Person) =>
    (await db.rpc(owner, "aal2", "save_employee", [null, FV, name, "CMA", true, who.appUserId, true])).id as string;
  anaE = await add("DEMO Ana", ana);
  beaE = await add("DEMO Bea", bea);
  monday = nextMonday();
}, 60_000);
afterAll(async () => db?.close());

const shift = async (emp: string, d: string) =>
  (await db.sql("SELECT is_off, branch_id, to_char(start_time, 'HH24:MI') s, state, note FROM public.shifts WHERE employee_id = $1 AND work_date = $2", [emp, d])).rows[0];

describe("weekly schedule", () => {
  it("patterns generate a draft week that staff can't see until published", async () => {
    // Ana off Mondays (1), Bea off Tuesdays (2)
    expect((await db.rpc(gm, "aal1", "save_schedule_pattern", [anaE, FV, [1], "10:00", "19:00"])).ok).toBe(true);
    expect((await db.rpc(gm, "aal1", "save_schedule_pattern", [beaE, FV, [2], "10:00", "19:00"])).ok).toBe(true);
    expect((await db.rpc(mkManager, "aal1", "save_schedule_pattern", [anaE, FV, [1], "10:00", "19:00"])).ok).toBe(false);
    expect((await db.rpc(gm, "aal1", "generate_week", [monday])).created).toBe(14);
    expect(await shift(anaE, monday)).toMatchObject({ is_off: true, state: "DRAFT" });
    expect(await shift(beaE, monday)).toMatchObject({ is_off: false, s: "10:00", branch_id: FV });
    const seen = await db.as(ana, "aal1", "SELECT count(*)::int n FROM public.shifts");
    expect(seen.rows[0].n).toBe(0);
    expect((await db.rpc(gm, "aal1", "publish_week", [monday])).published).toBe(14);
    expect((await db.as(ana, "aal1", "SELECT count(*)::int n FROM public.shifts")).rows[0].n).toBe(14);
    const notes = (await db.sql("SELECT count(*)::int n FROM public.notifications WHERE kind = 'SCHEDULE_PUBLISHED'")).rows[0].n;
    expect(notes).toBe(2);
  });

  it("adjusting a published day keeps it published and tells the person", async () => {
    const r = await db.rpc(gm, "aal1", "save_shift", [beaE, addDays(monday, 3), false, MK, "11:00", "19:00", "Cover Marikina"]);
    expect(r.ok).toBe(true);
    expect(await shift(beaE, addDays(monday, 3))).toMatchObject({ branch_id: MK, s: "11:00", state: "PUBLISHED" });
    expect((await db.sql("SELECT count(*)::int n FROM public.notifications WHERE kind = 'SCHEDULE_CHANGED' AND user_id = $1", [bea.appUserId])).rows[0].n).toBe(1);
  });

  it("a swap request, accepted by the coworker and approved by the GM, exchanges the two days", async () => {
    const r = await db.rpc(ana, "aal1", "request_schedule_change", ["SWAP", monday, beaE, null, "family event"]);
    expect(r).toMatchObject({ ok: true, state: "PENDING" });
    expect((await db.rpc(ana, "aal1", "decide_schedule_request", [r.id, true, null])).ok).toBe(false);
    expect((await db.rpc(bea, "aal1", "respond_schedule_swap", [r.id, true, null])).ok).toBe(true);
    expect((await db.rpc(gm, "aal1", "decide_schedule_request", [r.id, true, null])).state).toBe("APPROVED");
    expect(await shift(anaE, monday)).toMatchObject({ is_off: false, branch_id: FV, note: "Swapped" });
    expect(await shift(beaE, monday)).toMatchObject({ is_off: true });
  });

  it("moving a day off: work the day off, take another day off", async () => {
    const r = await db.rpc(bea, "aal1", "request_schedule_change", ["DAY_OFF", addDays(monday, 1), null, addDays(monday, 4), null]);
    expect(r.ok).toBe(true);
    expect((await db.rpc(owner, "aal2", "decide_schedule_request", [r.id, true, null])).ok).toBe(true);
    expect(await shift(beaE, addDays(monday, 1))).toMatchObject({ is_off: false, branch_id: FV });
    expect(await shift(beaE, addDays(monday, 4))).toMatchObject({ is_off: true });
  });

  it("week_schedule gives names: schedulers see drafts and patterns, staff only the published week", async () => {
    const next = addDays(monday, 7);
    await db.rpc(gm, "aal1", "generate_week", [next]);
    const g = await db.rpc(gm, "aal1", "week_schedule", [next]);
    expect(g.shifts.length).toBe(14);
    expect(g.people.find((p: { id: string }) => p.id === anaE)).toMatchObject({ name: "DEMO Ana", can_edit: true, pattern: { days_off: [1] } });
    const a = await db.rpc(ana, "aal1", "week_schedule", [next]);
    expect(a.me).toBe(anaE);
    expect(a.shifts.length).toBe(0);
    expect(a.people.find((p: { id: string }) => p.id === anaE).pattern).toBeNull();
    const pub = await db.rpc(ana, "aal1", "week_schedule", [monday]);
    expect(pub.shifts.length).toBe(14);
    expect(pub.people.map((p: { name: string }) => p.name).sort()).toEqual(["DEMO Ana", "DEMO Bea"]);
  });

  it("by branch: save a whole day (branches, off, leave) and copy last week", async () => {
    const d = addDays(monday, 14);
    const r = await db.rpc(gm, "aal1", "save_day", [d, JSON.stringify([{ employee: anaE, status: MK, start: "10:00", end: "19:00" }, { employee: beaE, status: "VL" }])]);
    expect(r).toMatchObject({ ok: true, saved: 2 });
    expect(await shift(anaE, d)).toMatchObject({ is_off: false, branch_id: MK });
    expect((await db.sql("SELECT is_off, leave_type FROM public.shifts WHERE employee_id = $1 AND work_date = $2", [beaE, d])).rows[0]).toEqual({ is_off: true, leave_type: "VL" });
    expect((await db.rpc(gm, "aal1", "save_day", [d, JSON.stringify([{ employee: anaE, status: MK, start: "10:00", end: "19:00" }])])).saved).toBe(0);
    expect((await db.rpc(mkManager, "aal1", "save_day", [d, JSON.stringify([{ employee: anaE, status: "OFF" }])])).ok).toBe(false);
    expect((await db.rpc(gm, "aal1", "save_day", [d, JSON.stringify([{ employee: anaE, status: "nonsense" }])])).ok).toBe(false);
    const c = await db.rpc(gm, "aal1", "copy_last_week", [addDays(monday, 21)]);
    expect(c.created).toBe(2);
    expect((await db.sql("SELECT is_off, leave_type FROM public.shifts WHERE employee_id = $1 AND work_date = $2", [beaE, addDays(d, 7)])).rows[0]).toEqual({ is_off: true, leave_type: null });
    const w = await db.rpc(gm, "aal1", "week_schedule", [addDays(monday, 14)]);
    expect(w.shifts.find((x: { employee_id: string; date: string }) => x.employee_id === beaE && x.date === d).leave).toBe("VL");
  });
});

describe("time clock and On Duty", () => {
  it("time in / out uses the database clock, needs a photo in the person's folder, and shows on On Duty", async () => {
    const d = today();
    await db.rpc(gm, "aal1", "save_shift", [anaE, d, false, FV, "00:00", "23:59", null]);
    await db.sql("UPDATE public.shifts SET state = 'PUBLISHED' WHERE employee_id = $1 AND work_date = $2", [anaE, d]);
    const photo = `${ana.appUserId}/11111111-1111-4111-8111-111111111111.jpg`;
    expect((await db.rpc(ana, "aal1", "clock_punch", ["IN", FV, null, null, null, null])).error).toBe("PHOTO_REQUIRED");
    expect((await db.rpc(ana, "aal1", "clock_punch", ["IN", FV, `${bea.appUserId}/11111111-1111-4111-8111-111111111111.jpg`, null, null, null])).error).toBe("PHOTO_REQUIRED");
    expect((await db.rpc(ana, "aal1", "clock_punch", ["OUT", FV, photo, null, null, null])).error).toBe("NOT_IN");
    await db.rpc(gm, "aal1", "set_branch_location", [FV, 14.7, 121.05]);
    const r = await db.rpc(ana, "aal1", "clock_punch", ["IN", FV, photo, 14.7009, 121.05, 20]);
    expect(r.ok).toBe(true);
    expect(r.distance_m).toBeGreaterThan(90);
    expect(r.distance_m).toBeLessThan(110);
    expect((await db.rpc(ana, "aal1", "clock_punch", ["IN", FV, photo, null, null, null])).error).toBe("ALREADY_IN");
    // The photo's own time is kept next to the server time; a nonsense one (a phone with a broken clock) is dropped.
    const taken = new Date(Date.now() - 3 * 3600_000).toISOString();
    expect((await db.rpc(ana, "aal1", "clock_punch", ["OUT", FV, photo, null, null, null, taken])).ok).toBe(true);
    expect((await db.rpc(ana, "aal1", "clock_punch", ["IN", FV, photo, null, null, null, "1999-01-01T00:00:00Z"])).ok).toBe(true);
    const { rows: kept } = await db.sql<{ kind: string; photo_taken_at: Date | null }>(
      "SELECT kind, photo_taken_at FROM public.time_punches WHERE employee_id = $1 AND work_date = $2 ORDER BY punched_at", [anaE, d]);
    expect(kept.map((k) => k.photo_taken_at?.toISOString() ?? null)).toEqual([null, taken, null]);
    const duty = await db.rpc(gm, "aal1", "on_duty", [d]);
    const row = duty.find((x: { employee_id: string }) => x.employee_id === anaE);
    expect(row.time_in).toBeTruthy();
    expect(row.late_min).toBeGreaterThanOrEqual(0);
    expect(await db.rpc(ana, "aal1", "on_duty", [d])).toEqual([]);
    const att = await db.rpc(owner, "aal2", "attendance", [d, d]);
    expect(att.find((x: { employee_id: string }) => x.employee_id === anaE)).toMatchObject({ scheduled: 1, present: 1, absent: 0 });
  });
});
