// update-0080: add-ons (e.g. L-Carnitine with a Lux Queen drip) are their own line of the same visit and pay 5% of
// what was paid for them, whatever the main service pays. DEMO fixtures only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, staff: Person, other: Person;
let ana: string, bea: string, bundle: string, facial: string, lcarn: string;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());

beforeAll(async () => {
  db = await TestDb.create();
  owner = await db.person("Owner", [["OWNER", null]]);
  staff = await db.person("Fairview Staff", [["CLINICIAN", "FAIRVIEW"]]);
  other = await db.person("Fairview Other", [["CLINICIAN", "FAIRVIEW"]]);
  ana = (await db.rpc(owner, "aal2", "save_employee", [null, db.branches.FAIRVIEW, "DEMO Ana", "CMA", true, staff.appUserId, true])).id;
  bea = (await db.rpc(owner, "aal2", "save_employee", [null, db.branches.FAIRVIEW, "DEMO Bea", "CMA", true, other.appUserId, true])).id;
  bundle = (await db.rpc(owner, "aal2", "save_service", [null, "DEMO Drip 10+3", 0, 8000, true])).id; // fixed ₱80 a session
  facial = (await db.rpc(owner, "aal2", "save_service", [null, "DEMO Facial", 100000, null, true])).id; // 5% of paid
  lcarn = (await db.rpc(owner, "aal2", "save_service", [null, "DEMO L-Carnitine", 50000, 4000, true])).id; // fixed ₱40, ignored as an add-on
  expect(await db.rpc(owner, "aal2", "set_service_addon", [lcarn, true])).toMatchObject({ ok: true });
}, 60_000);
afterAll(async () => db?.close());

const visit = async (svc: string, cents: number, type = "SOLO", partner: string | null = null, kind = "PAID") => {
  const folder = randomUUID();
  const list = ["WAIVER", "WAIVER", "BEFORE", "AFTER"].map((k) => ({ kind: k, path: `${db.branches.FAIRVIEW}/${folder}/${k.toLowerCase()}-${randomUUID()}.jpg`, thumb: null }));
  return db.rpc(staff, "aal1", "log_client_visit", [db.branches.FAIRVIEW, today(), svc, cents, type, ana, partner, null,
    kind, true, "DEMO Client", null, folder, JSON.stringify(list), false]);
};
const lines = async (id: string) => (await db.sql(`SELECT role, amount_cents::int amt FROM public.commission_lines WHERE service_log_id = $1 ORDER BY role`, [id])).rows;
const row = async (id: string) => (await db.sql(`SELECT amount_paid_cents::int amt, client_name, performer_id, assistant_id, note FROM public.service_logs WHERE id = $1`, [id])).rows[0];

describe("add-ons", () => {
  it("fixed-commission main service + 5% of the add-on", async () => {
    const v = await visit(bundle, 0);
    expect(v).toMatchObject({ ok: true });
    expect(await lines(v.id)).toEqual([{ role: "SOLO", amt: 8000 }]);
    const a = await db.rpc(staff, "aal1", "log_addon", [v.id, lcarn, 50000]);
    expect(a).toMatchObject({ ok: true });
    expect(await row(a.id)).toMatchObject({ amt: 50000, client_name: "DEMO Client", performer_id: ana, note: "Add-on" });
    expect(await lines(a.id)).toEqual([{ role: "SOLO", amt: 2500 }]);
  });
  it("5% main service + 5% of the add-on, split 60/40 with an assistant", async () => {
    const v = await visit(facial, 100000, "LEAD", bea);
    expect(await lines(v.id)).toEqual([{ role: "ASSIST", amt: 2000 }, { role: "LEAD", amt: 3000 }]);
    const a = await db.rpc(staff, "aal1", "log_addon", [v.id, lcarn, 50000]);
    expect(await row(a.id)).toMatchObject({ performer_id: ana, assistant_id: bea });
    expect(await lines(a.id)).toEqual([{ role: "ASSIST", amt: 1000 }, { role: "LEAD", amt: 1500 }]);
  });
  it("logging the add-on service on its own still pays its set commission", async () => {
    const v = await visit(lcarn, 50000);
    expect(await lines(v.id)).toEqual([{ role: "SOLO", amt: 4000 }]);
  });
  it("only add-on services, a paid amount, a paid visit, and whoever saved it", async () => {
    const v = await visit(facial, 100000);
    expect(await db.rpc(staff, "aal1", "log_addon", [v.id, facial, 50000])).toMatchObject({ ok: false, error: "UNKNOWN_SERVICE" });
    expect(await db.rpc(staff, "aal1", "log_addon", [v.id, lcarn, 0])).toMatchObject({ ok: false, error: "INVALID_AMOUNT" });
    expect(await db.rpc(other, "aal1", "log_addon", [v.id, lcarn, 50000])).toMatchObject({ ok: false, error: "NOT_ALLOWED" });
    expect(await db.rpc(owner, "aal2", "log_addon", [v.id, lcarn, 50000])).toMatchObject({ ok: true, state: "APPROVED" });
    const u = await visit(facial, 0, "NONCOMMI", null, "CHECKUP");
    expect(await db.rpc(staff, "aal1", "log_addon", [u.id, lcarn, 50000])).toMatchObject({ ok: false, error: "BAD_REQUEST" });
  });
  it("only management marks add-ons", async () => {
    expect(await db.rpc(staff, "aal1", "set_service_addon", [facial, true])).toMatchObject({ ok: false, error: "NOT_ALLOWED" });
  });
});
