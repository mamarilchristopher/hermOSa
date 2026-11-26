// update-0035: staff file VL/SL; owners and the GM approve with or without pay; the schedule updates by itself. DEMO fixtures only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, gm: Person, fvManager: Person, ana: Person, bea: Person;
let anaE: string, gmE: string, FV: string;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

beforeAll(async () => {
  db = await TestDb.create();
  FV = db.branches.FAIRVIEW;
  owner = await db.person("Owner", [["OWNER", null]]);
  gm = await db.person("General Manager", [["MANAGER", null]]);
  fvManager = await db.person("Fairview Manager", [["MANAGER", "FAIRVIEW"]]);
  ana = await db.person("Ana", [["CLINICIAN", "FAIRVIEW"]]);
  bea = await db.person("Bea", [["CLINICIAN", "FAIRVIEW"]]);
  anaE = (await db.rpc(owner, "aal2", "save_employee", [null, FV, "DEMO Ana", "CMA", true, ana.appUserId, true])).id;
  gmE = (await db.rpc(owner, "aal2", "save_employee", [null, FV, "DEMO GM", "General Manager", false, gm.appUserId, true])).id;
}, 60_000);
afterAll(async () => db?.close());

const shiftOn = async (emp: string, d: string) =>
  (await db.sql("SELECT is_off, leave_type, state, branch_id FROM public.shifts WHERE employee_id = $1 AND work_date = $2", [emp, d])).rows[0];

describe("leave requests", () => {
  it("checks dates: VL ahead only, SL up to 14 days back, no overlaps; staff without a record can't file", async () => {
    const t = today();
    expect((await db.rpc(bea, "aal1", "request_leave", ["VL", t, t, "DEMO trip"])).error).toBe("NO_EMPLOYEE_RECORD");
    expect((await db.rpc(ana, "aal1", "request_leave", ["VL", addDays(t, -1), t, "DEMO trip"])).error).toBe("LEAVE_DATES");
    expect((await db.rpc(ana, "aal1", "request_leave", ["SL", addDays(t, -20), addDays(t, -19), "DEMO flu"])).error).toBe("LEAVE_DATES");
    expect((await db.rpc(ana, "aal1", "request_leave", ["VL", addDays(t, 5), addDays(t, 3), "DEMO trip"])).error).toBe("BAD_REQUEST");
    expect((await db.rpc(ana, "aal1", "request_leave", ["SL", addDays(t, -2), addDays(t, -2), "DEMO flu"])).ok).toBe(true);
    expect((await db.rpc(ana, "aal1", "request_leave", ["VL", addDays(t, -2), addDays(t, 1), "DEMO trip"])).error).toBe("LEAVE_DATES");
    expect((await db.rpc(ana, "aal1", "request_leave", ["SL", addDays(t, -3), addDays(t, -1), "DEMO flu"])).error).toBe("LEAVE_OVERLAP");
  });

  it("owners and the GM are told; a branch manager sees it but can't approve", async () => {
    const told = (await db.sql("SELECT user_id FROM public.notifications WHERE kind = 'LEAVE_FILED'")).rows.map((r) => r.user_id).sort();
    expect(told).toEqual([owner.appUserId, gm.appUserId].sort());
    const id = (await db.sql("SELECT id FROM public.leave_requests WHERE employee_id = $1", [anaE])).rows[0].id;
    expect((await db.as(fvManager, "aal1", "SELECT count(*)::int n FROM public.leave_requests")).rows[0].n).toBe(1);
    expect((await db.as(bea, "aal1", "SELECT count(*)::int n FROM public.leave_requests")).rows[0].n).toBe(0);
    expect((await db.rpc(fvManager, "aal1", "decide_leave", [id, true, true, null])).ok).toBe(false);
  });

  it("approval needs a pay choice, skips rest days, and writes the leave onto the schedule with notices", async () => {
    const t = today();
    const a = addDays(t, 10), b = addDays(t, 11), c = addDays(t, 12);
    // b is already a day off on the schedule: it stays a rest day.
    await db.sql(`INSERT INTO public.shifts (organization_id, employee_id, work_date, is_off, state, updated_by)
      SELECT organization_id, id, $2, true, 'PUBLISHED', $3 FROM public.employees WHERE id = $1`, [anaE, b, gm.appUserId]);
    await db.sql(`INSERT INTO public.shifts (organization_id, employee_id, work_date, branch_id, start_time, end_time, is_off, state, updated_by)
      SELECT organization_id, id, $2, $3, '10:00', '19:00', false, 'DRAFT', $4 FROM public.employees WHERE id = $1`, [anaE, a, FV, gm.appUserId]);
    const r = await db.rpc(ana, "aal1", "request_leave", ["VL", a, c, "DEMO family trip"]);
    expect(r.days).toBe(2);
    expect((await db.rpc(gm, "aal1", "decide_leave", [r.id, true, null, null])).error).toBe("PAY_CHOICE_REQUIRED");
    const ok = await db.rpc(gm, "aal1", "decide_leave", [r.id, true, true, null]);
    expect(ok).toMatchObject({ ok: true, days: 2 });
    // update-0078: the GM decided, so every manager's notice for this leave is cleared.
    expect((await db.sql("SELECT count(*)::int n FROM public.notifications n JOIN public.leave_requests l ON l.filed_by = n.created_by AND l.filed_at = n.created_at WHERE l.id = $1 AND n.kind = 'LEAVE_FILED' AND n.read_at IS NULL", [r.id])).rows[0].n).toBe(0);
    expect((await db.sql("SELECT count(*)::int n FROM public.notifications n JOIN public.leave_requests l ON l.filed_by = n.created_by AND l.filed_at = n.created_at WHERE l.id = $1 AND n.kind = 'LEAVE_FILED'", [r.id])).rows[0].n).toBeGreaterThan(0);
    expect(await shiftOn(anaE, a)).toMatchObject({ is_off: true, leave_type: "VL", state: "PUBLISHED", branch_id: null });
    expect(await shiftOn(anaE, b)).toMatchObject({ is_off: true, leave_type: null });
    expect(await shiftOn(anaE, c)).toMatchObject({ is_off: true, leave_type: "VL", state: "PUBLISHED" });
    const req = (await db.sql("SELECT state, with_pay, days FROM public.leave_requests WHERE id = $1", [r.id])).rows[0];
    expect(req).toEqual({ state: "APPROVED", with_pay: true, days: 2 });
    const body = (await db.sql("SELECT body FROM public.notifications WHERE kind = 'LEAVE_APPROVED' AND user_id = $1", [ana.appUserId])).rows[0].body;
    expect(body).toContain("with pay");
    const mgrs = (await db.sql("SELECT user_id FROM public.notifications WHERE kind = 'LEAVE_APPROVED' AND user_id <> $1", [ana.appUserId])).rows.map((x) => x.user_id);
    expect(mgrs).toContain(fvManager.appUserId);
    expect((await db.rpc(gm, "aal1", "decide_leave", [r.id, true, true, null])).error).toBe("NOT_PENDING");
  });

  it("decline needs a note; staff can withdraw a pending one; the GM's own leave needs an owner", async () => {
    const id = (await db.sql("SELECT id FROM public.leave_requests WHERE employee_id = $1 AND kind = 'SL'", [anaE])).rows[0].id;
    expect((await db.rpc(gm, "aal1", "decide_leave", [id, false, null, ""])).error).toBe("NOTE_REQUIRED");
    expect((await db.rpc(gm, "aal1", "decide_leave", [id, false, null, "DEMO please attach a medical certificate"])).ok).toBe(true);
    expect((await db.sql("SELECT body FROM public.notifications WHERE kind = 'LEAVE_DECLINED'")).rows[0].body).toContain("medical certificate");

    const t = today();
    const w = await db.rpc(ana, "aal1", "request_leave", ["VL", addDays(t, 20), addDays(t, 20), "DEMO errand"]);
    expect((await db.rpc(ana, "aal1", "cancel_leave", [w.id])).ok).toBe(true);
    expect((await db.rpc(ana, "aal1", "cancel_leave", [w.id])).error).toBe("NOT_PENDING");

    const g = await db.rpc(gm, "aal1", "request_leave", ["VL", addDays(t, 30), addDays(t, 30), "DEMO rest"]);
    expect((await db.rpc(gm, "aal1", "decide_leave", [g.id, true, true, null])).error).toBe("SELF_APPROVAL_DENIED");
    expect((await db.rpc(owner, "aal2", "decide_leave", [g.id, true, false, null])).ok).toBe(true);
    expect(await shiftOn(gmE, addDays(t, 30))).toMatchObject({ leave_type: "VL" });
  });
});
