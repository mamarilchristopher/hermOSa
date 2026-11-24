// Duplicate checks, unpaid visits and sign-off reminders (0020). All people are DEMO fixtures.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, gm: Person, staff: Person;
let ana: string, bea: string, svc: string;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());

beforeAll(async () => {
  db = await TestDb.create();
  owner = await db.person("Owner", [["OWNER", null]]);
  gm = await db.person("General Manager", [["MANAGER", null]]);
  staff = await db.person("Fairview Staff", [["CLINICIAN", "FAIRVIEW"]]);
  const add = async (name: string, login: Person | null = null) =>
    (await db.rpc(owner, "aal2", "save_employee", [null, db.branches.FAIRVIEW, name, "CMA", true, login?.appUserId ?? null, true])).id as string;
  ana = await add("DEMO Ana", staff);
  bea = await add("DEMO Bea");
  svc = (await db.rpc(gm, "aal1", "add_service", ["DEMO Facial"])).id;
}, 60_000);
afterAll(async () => db?.close());

const visit = (who: Person, amount: number, opts: { receipt?: string; kind?: string; confirm?: boolean; emp?: string } = {}) =>
  db.rpc(who, "aal1", "log_visit", [db.branches.FAIRVIEW, today(), svc, amount, "SOLO", opts.emp ?? ana, null,
    opts.receipt ?? null, null, opts.kind ?? "PAID", opts.confirm ?? false]);

describe("log_visit", () => {
  it("logs a paid service like before", async () => {
    expect(await visit(staff, 250_000, { receipt: "W-100" })).toMatchObject({ ok: true, state: "PENDING" });
  });

  it("asks before logging the same day, service, amount and staff again, and shows who logged it", async () => {
    const r = await visit(gm, 250_000);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("POSSIBLE_DUPLICATE");
    expect(r.existing.by).toBe("DEMO Fairview Staff");
    expect(await visit(gm, 250_000, { confirm: true })).toMatchObject({ ok: true });
    expect(await visit(gm, 300_000)).toMatchObject({ ok: true }); // different amount: no question
  });

  it("refuses a waiver / OR number already used at the branch", async () => {
    const r = await visit(gm, 999_900, { receipt: "w-100", confirm: true, emp: bea });
    expect(r).toMatchObject({ ok: false, error: "DUPLICATE_RECEIPT" });
  });

  it("logs unpaid visits at ₱0 with no commission", async () => {
    const r = await visit(staff, 0, { kind: "BACKJOB", emp: bea });
    expect(r.ok).toBe(true);
    const row = (await db.sql("SELECT visit_kind, amount_paid_cents::int AS a, commission_type FROM public.service_logs WHERE id = $1", [r.id])).rows[0];
    expect(row).toEqual({ visit_kind: "BACKJOB", a: 0, commission_type: "NONCOMMI" });
    expect((await db.sql("SELECT count(*)::int AS n FROM public.commission_lines WHERE service_log_id = $1", [r.id])).rows[0].n).toBe(0);
    expect(await visit(staff, 0, { kind: "PAID", emp: bea })).toMatchObject({ ok: false, error: "INVALID_AMOUNT" });
  });

  it("counts sign-offs waiting: all for the manager, own commission for staff", async () => {
    const m = await db.rpc(gm, "aal1", "pending_signoffs", []);
    expect(m.to_sign.count).toBe(4);
    const s = await db.rpc(staff, "aal1", "pending_signoffs", []);
    expect(s.to_sign.count).toBe(0);
    expect(s.mine.count).toBe(3);
    expect(s.mine.oldest).toBe(today());
  });
});
