// update-0068: bundles pay their fixed commission every session, ₱0 sessions included. DEMO fixtures only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, staff: Person;
let ana: string, bundle: string;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());

beforeAll(async () => {
  db = await TestDb.create();
  owner = await db.person("Owner", [["OWNER", null]]);
  staff = await db.person("Fairview Staff", [["CLINICIAN", "FAIRVIEW"]]);
  ana = (await db.rpc(owner, "aal2", "save_employee", [null, db.branches.FAIRVIEW, "DEMO Ana", "CMA", true, staff.appUserId, true])).id;
  bundle = (await db.rpc(owner, "aal2", "save_service", [null, "DEMO Bundle 10+3", 0, 8000, true])).id;
  await db.sql("UPDATE public.services SET session_prices = ARRAY[680000,250000,0]::bigint[] WHERE id = $1", [bundle]);
}, 60_000);
afterAll(async () => db?.close());

const visit = async (amount: number, session: number, client: string) => {
  const folder = randomUUID();
  const list = ["WAIVER", "WAIVER", "BEFORE", "AFTER"].map((k) => ({ kind: k, path: `${db.branches.FAIRVIEW}/${folder}/${k.toLowerCase()}-${randomUUID()}.jpg`, thumb: null }));
  return db.rpc(staff, "aal1", "log_client_visit", [db.branches.FAIRVIEW, today(), bundle, amount, "SOLO", ana, null, null,
    "PAID", true, client, null, folder, JSON.stringify(list), false, session]);
};
const commission = async (id: string) => (await db.sql("SELECT coalesce(sum(amount_cents), 0)::int c FROM public.commission_lines WHERE service_log_id = $1", [id])).rows[0].c;

describe("bundles", () => {
  it("each session pays the set commission, whatever is paid that day", async () => {
    const first = await visit(680000, 1, "DEMO Client A");
    expect(first).toMatchObject({ ok: true });
    expect(await commission(first.id)).toBe(8000);
    const paid = await visit(250000, 2, "DEMO Client B");
    expect(await commission(paid.id)).toBe(8000);
    const free = await visit(0, 3, "DEMO Client C");
    expect(free).toMatchObject({ ok: true });
    expect(await commission(free.id)).toBe(8000);
  });
});
