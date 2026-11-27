// update-0095 (Geraldine's list, Nov 27): fix a misspelled client name; move an entry to the right branch. DEMO fixtures only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, gm: Person, staff: Person, other: Person;
let ana: string, hiko: string;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());

beforeAll(async () => {
  db = await TestDb.create();
  owner = await db.person("Owner", [["OWNER", null]]);
  gm = await db.person("General Manager", [["MANAGER", null]]);
  staff = await db.person("Fairview Staff", [["CLINICIAN", "FAIRVIEW"]]);
  other = await db.person("Marikina Staff", [["CLINICIAN", "MARIKINA"]]);
  ana = (await db.rpc(owner, "aal2", "save_employee", [null, db.branches.FAIRVIEW, "DEMO Ana", "CMA", true, staff.appUserId, true])).id;
  hiko = (await db.rpc(owner, "aal2", "save_service", [null, "DEMO Hiko", 899900, 45000, true])).id;
}, 60_000);
afterAll(async () => db?.close());

const visit = async (client: string) => {
  const folder = randomUUID();
  const pic = (k: string) => { const id = randomUUID(); return { kind: k, path: `${db.branches.FAIRVIEW}/${folder}/${k.toLowerCase()}-${id}.jpg`, thumb: null }; };
  const r = await db.rpc(staff, "aal1", "log_client_visit", [db.branches.FAIRVIEW, today(), hiko, 899900, "SOLO", ana, null, null,
    "PAID", true, client, null, folder, JSON.stringify(["WAIVER", "WAIVER", "BEFORE", "AFTER"].map(pic)), false]);
  expect(r.ok).toBe(true);
  return r.id as string;
};
const names = async () => (await db.sql("SELECT client_name FROM public.service_logs ORDER BY created_at")).rows.map((r) => r.client_name);

describe("client name fix", () => {
  it("staff fix their own entry; management can fix every entry with that name, even approved ones", async () => {
    const a = await visit("DEMO Cregancia"), b = await visit("demo cregancia"), c = await visit("DEMO Other");
    await db.rpc(owner, "aal2", "approve_service_logs", [[b]]);
    expect((await db.rpc(other, "aal1", "rename_service_client", [a, "DEMO Cregencia", false])).ok).toBe(false);
    expect(await db.rpc(staff, "aal1", "rename_service_client", [a, "DEMO Cregencia", true])).toMatchObject({ ok: false, error: "NOT_ALLOWED" });
    expect(await db.rpc(staff, "aal1", "rename_service_client", [a, "x", false])).toMatchObject({ ok: false, error: "CLIENT_NAME_REQUIRED" });
    expect(await db.rpc(staff, "aal1", "rename_service_client", [a, "  DEMO   Cregencia ", false])).toMatchObject({ ok: true, changed: 1 });
    expect(await names()).toEqual(["DEMO Cregencia", "demo cregancia", "DEMO Other"]);
    expect(await db.rpc(gm, "aal1", "rename_service_client", [b, "DEMO Mary Cregencia", true])).toMatchObject({ ok: true, changed: 1 });
    expect(await names()).toEqual(["DEMO Cregencia", "DEMO Mary Cregencia", "DEMO Other"]);
    expect(await db.rpc(owner, "aal2", "rename_service_client", [a, "DEMO Mary Cregencia", true])).toMatchObject({ ok: true, changed: 1 });
    expect(await names()).toEqual(["DEMO Mary Cregencia", "DEMO Mary Cregencia", "DEMO Other"]);
    void c;
  });
});

describe("branch fix", () => {
  it("owners and the GM move an entry and its photos to the right branch", async () => {
    const a = await visit("DEMO Branch Client");
    expect((await db.rpc(staff, "aal1", "change_service_branch", [a, db.branches.MARIKINA])).ok).toBe(false);
    expect((await db.rpc(gm, "aal1", "change_service_branch", [a, db.branches.MARIKINA])).ok).toBe(true);
    const row = (await db.sql("SELECT l.branch_id, (SELECT count(*)::int FROM public.service_photos p WHERE p.service_log_id = l.id AND p.branch_id = l.branch_id) n FROM public.service_logs l WHERE id = $1", [a])).rows[0];
    expect(row).toEqual({ branch_id: db.branches.MARIKINA, n: 4 });
    await db.rpc(owner, "aal2", "approve_service_logs", [[a]]);
    expect((await db.rpc(owner, "aal2", "change_service_branch", [a, db.branches.FAIRVIEW])).ok).toBe(true); // approved entries too
    const lines = (await db.sql("SELECT count(*)::int n FROM public.commission_lines WHERE service_log_id = $1", [a])).rows[0].n;
    expect(lines).toBe(1); // commission unchanged
  });
});

describe("double dose", () => {
  it("adds the next session of the package to the visit, with its usual commission", async () => {
    const vc = (await db.sql(`INSERT INTO public.services (organization_id, name, price_cents, commission_cents, session_prices, active, created_by)
      SELECT organization_id, 'DEMO VContour 10+3', 0, 5769, array_fill(0::bigint, ARRAY[13]), true, $1 FROM public.branches LIMIT 1 RETURNING id`, [owner.appUserId])).rows[0].id as string;
    const folder = randomUUID();
    const pic = (k: string) => { const id = randomUUID(); return { kind: k, path: `${db.branches.FAIRVIEW}/${folder}/${k.toLowerCase()}-${id}.jpg`, thumb: null }; };
    const main = await db.rpc(staff, "aal1", "log_client_visit", [db.branches.FAIRVIEW, today(), vc, 150000, "SOLO", ana, null, null,
      "PAID", true, "DEMO Double Client", null, folder, JSON.stringify(["WAIVER", "WAIVER", "BEFORE", "AFTER"].map(pic)), false, 12, true]);
    expect(main.ok).toBe(true);
    expect((await db.rpc(other, "aal1", "log_double_dose", [main.id])).ok).toBe(false);
    const r = await db.rpc(staff, "aal1", "log_double_dose", [main.id]);
    expect(r).toMatchObject({ ok: true, session: 13 });
    const row = (await db.sql(`SELECT l.session_no, l.amount_paid_cents::int amt, l.client_name, l.photos_due, l.note,
      (SELECT sum(amount_cents)::int FROM public.commission_lines c WHERE c.service_log_id = l.id) com FROM public.service_logs l WHERE id = $1`, [r.id])).rows[0];
    expect(row).toEqual({ session_no: 13, amt: 0, client_name: "DEMO Double Client", photos_due: false, note: "Double dose", com: 5769 });
    expect(await db.rpc(staff, "aal1", "log_double_dose", [r.id])).toMatchObject({ ok: false, error: "SESSION_LIMIT" }); // no session 14
    const plain = await visit("DEMO Not Package");
    expect(await db.rpc(staff, "aal1", "log_double_dose", [plain])).toMatchObject({ ok: false, error: "NOT_A_PACKAGE" });
  });
});
