// update-0069: Meds are their own line of the same visit, no commission; a free package is a ₱0 No charge line. DEMO fixtures only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, staff: Person, other: Person;
let ana: string, svc: string, pack: string, mupi: string;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());

beforeAll(async () => {
  db = await TestDb.create();
  owner = await db.person("Owner", [["OWNER", null]]);
  staff = await db.person("Fairview Staff", [["CLINICIAN", "FAIRVIEW"]]);
  other = await db.person("Fairview Other", [["CLINICIAN", "FAIRVIEW"]]);
  ana = (await db.rpc(owner, "aal2", "save_employee", [null, db.branches.FAIRVIEW, "DEMO Ana", "CMA", true, staff.appUserId, true])).id;
  svc = (await db.rpc(owner, "aal2", "save_service", [null, "DEMO Facial", 100000, 5000, true])).id;
  pack = (await db.rpc(owner, "aal2", "save_service", [null, "DEMO Meds Package", 80000, 0, true])).id;
  mupi = (await db.rpc(owner, "aal2", "save_service", [null, "DEMO Mupirocin", 30000, 0, true])).id;
  await db.sql("UPDATE public.services SET is_meds = true WHERE id = ANY($1::uuid[])", [[pack, mupi]]);
}, 60_000);
afterAll(async () => db?.close());

const visit = async () => {
  const folder = randomUUID();
  const list = ["WAIVER", "WAIVER", "BEFORE", "AFTER"].map((k) => ({ kind: k, path: `${db.branches.FAIRVIEW}/${folder}/${k.toLowerCase()}-${randomUUID()}.jpg`, thumb: null }));
  return db.rpc(staff, "aal1", "log_client_visit", [db.branches.FAIRVIEW, today(), svc, 100000, "SOLO", ana, null, null,
    "PAID", true, "DEMO Client", null, folder, JSON.stringify(list), false]);
};
const row = async (id: string) => (await db.sql(`SELECT l.amount_paid_cents::int amt, l.client_name, l.photos_due, l.visit_kind, l.performer_id,
  (SELECT coalesce(sum(c.amount_cents), 0)::int FROM public.commission_lines c WHERE c.service_log_id = l.id) comm FROM public.service_logs l WHERE l.id = $1`, [id])).rows[0];

describe("meds", () => {
  it("adds a paid meds line to the visit with no commission", async () => {
    const v = await visit();
    expect(v).toMatchObject({ ok: true });
    const m = await db.rpc(staff, "aal1", "log_meds", [v.id, pack, false]);
    expect(m).toMatchObject({ ok: true });
    expect(await row(m.id)).toMatchObject({ amt: 80000, client_name: "DEMO Client", photos_due: false, comm: 0, performer_id: ana });
  });
  it("a free package is a ₱0 No charge line", async () => {
    const v = await visit();
    const m = await db.rpc(staff, "aal1", "log_meds", [v.id, pack, true]);
    expect(m).toMatchObject({ ok: true });
    expect(await row(m.id)).toMatchObject({ amt: 0, visit_kind: "NO_CHARGE", comm: 0 });
  });
  it("only meds, and only by whoever saved the visit", async () => {
    const v = await visit();
    expect(await db.rpc(staff, "aal1", "log_meds", [v.id, svc, false])).toMatchObject({ ok: false, error: "UNKNOWN_SERVICE" });
    expect(await db.rpc(other, "aal1", "log_meds", [v.id, mupi, false])).toMatchObject({ ok: false, error: "NOT_ALLOWED" });
    expect(await db.rpc(owner, "aal2", "log_meds", [v.id, mupi, false])).toMatchObject({ ok: true, state: "APPROVED" });
  });
});
