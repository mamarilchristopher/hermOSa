// Daily service log and commissions. All people are DEMO fixtures.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, gm: Person, fvManager: Person, fvStaff: Person, mkStaff: Person, hr: Person;
let ana: string, bea: string, cara: string, dina: string, svc: string;

const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());
const daysAgo = (n: number) => new Date(Date.parse(`${today()}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);

beforeAll(async () => {
  db = await TestDb.create();
  owner = await db.person("Owner", [["OWNER", null]]);
  gm = await db.person("General Manager", [["MANAGER", null]]);
  fvManager = await db.person("Fairview Manager", [["MANAGER", "FAIRVIEW"]]);
  fvStaff = await db.person("Fairview Staff", [["CLINICIAN", "FAIRVIEW"]]);
  mkStaff = await db.person("Marikina Staff", [["CLINICIAN", "MARIKINA"]]);
  hr = await db.person("HR", [["HR", null]]);
  const add = async (name: string, eligible = true, login: Person | null = null) => {
    const r = await db.rpc(owner, "aal2", "save_employee", [null, db.branches.FAIRVIEW, name, "Therapist", eligible, login?.appUserId ?? null, true]);
    expect(r.ok).toBe(true);
    return r.id as string;
  };
  ana = await add("DEMO Ana", true, fvStaff);
  bea = await add("DEMO Bea");
  cara = await add("DEMO Cara", false); // not commission-based
  dina = await add("DEMO Dina");
  const s = await db.rpc(fvManager, "aal1", "add_service", ["DEMO Facial"]);
  expect(s.ok).toBe(true);
  svc = s.id;
}, 60_000);

afterAll(async () => db?.close());

const lines = async (logId: string) =>
  (await db.sql("SELECT role, amount_cents::int AS c, employee_id FROM public.commission_lines WHERE service_log_id = $1 ORDER BY role DESC", [logId])).rows;

describe("logging services", () => {
  it("lead + assistant: 5% of paid, split 60/40", async () => {
    const r = await db.rpc(fvStaff, "aal1", "log_service", [db.branches.FAIRVIEW, daysAgo(0), svc, 1_000_000, "LEAD", ana, bea, null, null]);
    expect(r).toMatchObject({ ok: true, state: "PENDING" });
    expect(await lines(r.id)).toEqual([
      { role: "LEAD", c: 30000, employee_id: ana },
      { role: "ASSIST", c: 20000, employee_id: bea },
    ]);
  });

  it("assist entry is stored as the same lead/assist pair", async () => {
    const r = await db.rpc(fvStaff, "aal1", "log_service", [db.branches.FAIRVIEW, daysAgo(0), svc, 333_300, "ASSIST", ana, dina, null, null]);
    const l = await lines(r.id);
    // ₱3,333 paid -> ₱166.65 commission -> lead ₱99.99, assistant gets the rest ₱66.66
    expect(l).toEqual([{ role: "LEAD", c: 9999, employee_id: dina }, { role: "ASSIST", c: 6666, employee_id: ana }]);
  });

  it("solo gets the full 5%; non-commission staff get no line; NONCOMMI has none", async () => {
    const solo = await db.rpc(fvStaff, "aal1", "log_service", [db.branches.FAIRVIEW, daysAgo(0), svc, 600_000, "SOLO", bea, null, null, null]);
    expect(await lines(solo.id)).toEqual([{ role: "SOLO", c: 30000, employee_id: bea }]);
    const ineligible = await db.rpc(fvStaff, "aal1", "log_service", [db.branches.FAIRVIEW, daysAgo(0), svc, 600_000, "LEAD", cara, ana, null, null]);
    expect(await lines(ineligible.id)).toEqual([{ role: "ASSIST", c: 12000, employee_id: ana }]);
    const nc = await db.rpc(fvStaff, "aal1", "log_service", [db.branches.FAIRVIEW, daysAgo(0), svc, 600_000, "NONCOMMI", bea, null, null, null]);
    expect(await lines(nc.id)).toEqual([]);
  });

  it("lead needs an assistant, not the same person; staff can't log for another branch; no future dates", async () => {
    expect((await db.rpc(fvStaff, "aal1", "log_service", [db.branches.FAIRVIEW, daysAgo(0), svc, 1000, "LEAD", ana, null, null, null])).error).toBe("ASSISTANT_REQUIRED");
    expect((await db.rpc(fvStaff, "aal1", "log_service", [db.branches.FAIRVIEW, daysAgo(0), svc, 1000, "LEAD", ana, ana, null, null])).error).toBe("SAME_PERSON");
    // update-0092: staff aren't locked to their home branch (a Marikina CMA working at Fairview logs there).
    expect((await db.rpc(mkStaff, "aal1", "log_service", [db.branches.FAIRVIEW, daysAgo(0), svc, 1000, "SOLO", ana, null, null, null])).ok).toBe(true);
    expect((await db.rpc(fvStaff, "aal1", "log_service", [db.branches.FAIRVIEW, "2999-01-01", svc, 1000, "SOLO", ana, null, null, null])).error).toBe("INVALID_DATE");
  });
});

describe("sign-off and visibility", () => {
  it("the general manager signs off entries one by one; staff and other branches can't", async () => {
    const r = await db.rpc(fvStaff, "aal1", "log_service", [db.branches.FAIRVIEW, daysAgo(3), svc, 200_000, "SOLO", bea, null, null, null]);
    expect((await db.rpc(fvStaff, "aal1", "decide_service_log", [r.id, true, null])).error).toBe("FORBIDDEN");
    const overdue = await db.rpc(gm, "aal1", "overdue_commission_days", []);
    expect(overdue).toEqual([expect.objectContaining({ code: "FAIRVIEW", date: daysAgo(3), pending: 1 })]);
    expect(await db.rpc(fvStaff, "aal1", "overdue_commission_days", [])).toEqual([]);
    expect((await db.rpc(gm, "aal1", "decide_service_log", [r.id, false, null])).error).toBe("REASON_REQUIRED");
    expect((await db.rpc(gm, "aal1", "decide_service_log", [r.id, true, null])).state).toBe("APPROVED");
    expect((await db.rpc(fvManager, "aal1", "decide_service_log", [r.id, true, null])).error).toBe("NOT_PENDING");
    expect(await db.rpc(gm, "aal1", "overdue_commission_days", [])).toEqual([]);
    await expect(db.sql("UPDATE public.service_logs SET amount_paid_cents = 1 WHERE id = $1", [r.id])).rejects.toThrow(/SERVICE_LOG_ALREADY_DECIDED/);
    await expect(db.sql("DELETE FROM public.commission_lines")).rejects.toThrow(/COMMISSION_LINES_ARE_IMMUTABLE/);
  });

  it("nobody signs off an entry they're paid on or logged (switch on)", async () => {
    const asAna = await db.person("Ana as manager", [["MANAGER", "FAIRVIEW"]]);
    await db.sql("UPDATE public.employees SET app_user_id = $1 WHERE id = $2", [asAna.appUserId, dina]);
    const r = await db.rpc(fvStaff, "aal1", "log_service", [db.branches.FAIRVIEW, daysAgo(1), svc, 100_000, "LEAD", dina, bea, null, null]);
    expect((await db.rpc(asAna, "aal1", "decide_service_log", [r.id, true, null])).error).toBe("SELF_APPROVAL_DENIED");
    const own = await db.rpc(fvManager, "aal1", "log_service", [db.branches.FAIRVIEW, daysAgo(1), svc, 100_000, "SOLO", bea, null, null, null]);
    expect((await db.rpc(fvManager, "aal1", "decide_service_log", [own.id, true, null])).error).toBe("SELF_APPROVAL_DENIED");
  });

  it("staff see only their own commission amounts; managers see the branch's; other branches see no commission", async () => {
    const mine = await db.as(fvStaff, "aal1", "SELECT DISTINCT employee_id FROM public.commission_lines");
    expect(mine.rows.map((r) => r.employee_id)).toEqual([ana]);
    const mgr = await db.as(fvManager, "aal1", "SELECT count(DISTINCT employee_id)::int AS n FROM public.commission_lines");
    expect(mgr.rows[0].n).toBeGreaterThan(1);
    // update-0092: staff of another branch see the entries (they may work there), but never others' commission.
    expect((await db.as(mkStaff, "aal1", "SELECT count(*)::int AS n FROM public.commission_lines WHERE employee_id = $1", [ana])).rows[0].n).toBe(0);
  });

  it("a cashier or clinician can't add employees; HR (with MFA) can", async () => {
    expect((await db.rpc(fvStaff, "aal1", "save_employee", [null, db.branches.FAIRVIEW, "DEMO X", null, true, null, true])).error).toBe("FORBIDDEN");
    expect((await db.rpc(hr, "aal2", "save_employee", [null, db.branches.FAIRVIEW, "DEMO Y", null, true, null, true])).ok).toBe(true);
  });
});
