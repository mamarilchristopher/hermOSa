// update-0042: price list and commission per service. DEMO fixtures only.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, gm: Person, fvManager: Person, staff: Person;
let ana: string, bea: string;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());

beforeAll(async () => {
  db = await TestDb.create();
  owner = await db.person("Owner", [["OWNER", null]]);
  gm = await db.person("General Manager", [["MANAGER", null]]);
  fvManager = await db.person("Fairview Manager", [["MANAGER", "FAIRVIEW"]]);
  staff = await db.person("Fairview Staff", [["CLINICIAN", "FAIRVIEW"]]);
  const add = async (name: string, login: Person | null = null) =>
    (await db.rpc(owner, "aal2", "save_employee", [null, db.branches.FAIRVIEW, name, "CMA", true, login?.appUserId ?? null, true])).id as string;
  ana = await add("DEMO Ana", staff);
  bea = await add("DEMO Bea");
}, 60_000);
afterAll(async () => db?.close());

const lines = async (log: string) =>
  (await db.sql("SELECT role, amount_cents::int a FROM public.commission_lines WHERE service_log_id = $1 ORDER BY role DESC", [log])).rows;

describe("service prices and commissions", () => {
  let svc: string;
  it("owners and the GM add and edit services; branch managers and staff can't", async () => {
    const r = await db.rpc(gm, "aal1", "save_service", [null, "DEMO Thread Lift", 899900, 45000, true]);
    expect(r.ok).toBe(true);
    svc = r.id;
    expect((await db.rpc(fvManager, "aal1", "save_service", [null, "DEMO Other", 100000, null, true])).ok).toBe(false);
    expect((await db.rpc(staff, "aal1", "save_service", [svc, "DEMO Thread Lift", 1, 1, true])).ok).toBe(false);
    expect((await db.rpc(owner, "aal2", "save_service", [null, "demo thread lift", 1, null, true])).error).toBe("SERVICE_EXISTS");
    expect((await db.rpc(owner, "aal2", "save_service", [svc, "DEMO Thread Lift", 899900, 45000, true])).ok).toBe(true);
  });

  it("a set commission is paid as is (60/40 for lead/assist); no set commission means 5% of the amount", async () => {
    const solo = await db.rpc(staff, "aal1", "log_visit", [db.branches.FAIRVIEW, today(), svc, 800000, "SOLO", ana, null, null, null, "PAID", true]);
    // update-0053: paid less than the list price (a discount), so 5% of what was paid instead of the set commission
    expect(await lines(solo.id)).toEqual([{ role: "SOLO", a: 40000 }]);
    // bea has no login but is commission eligible
    const pair = await db.rpc(staff, "aal1", "log_visit", [db.branches.FAIRVIEW, today(), svc, 899900, "LEAD", ana, bea, null, null, "PAID", true]);
    expect(await lines(pair.id)).toEqual([{ role: "LEAD", a: 27000 }, { role: "ASSIST", a: 18000 }]);
    const plain = (await db.rpc(gm, "aal1", "save_service", [null, "DEMO Facial", 100000, null, true])).id;
    const p = await db.rpc(staff, "aal1", "log_visit", [db.branches.FAIRVIEW, today(), plain, 100000, "SOLO", ana, null, null, null, "PAID", true]);
    expect(await lines(p.id)).toEqual([{ role: "SOLO", a: 5000 }]);
    const free = await db.rpc(staff, "aal1", "log_visit", [db.branches.FAIRVIEW, today(), svc, 0, "SOLO", ana, null, null, null, "CHECKUP", true]);
    expect(await lines(free.id)).toEqual([]);
  });

  it("the price list loads once an owner exists, and running it again doesn't duplicate", async () => {
    const sql = readFileSync("supabase/migrations/20261125000042_prices_and_booking_value.sql", "utf8");
    const seed = sql.slice(sql.indexOf("WITH list(name"));
    await db.sql(seed);
    await db.sql(seed);
    const { rows } = await db.sql("SELECT price_cents::int p, commission_cents::int c FROM public.services WHERE name = 'Hiko Deluxe'");
    expect(rows).toEqual([{ p: 899900, c: 45000 }]);
    expect((await db.sql("SELECT count(*)::int n FROM public.services WHERE name LIKE 'Diode %'")).rows[0].n).toBe(12);
  });

  it("update-0048: a follow-up dose priced at P0 with a set commission pays that commission with nothing paid", async () => {
    const d2 = (await db.rpc(owner, "aal2", "save_service", [null, "DEMO Arms 2nd dose", 0, 5000, true])).id;
    const log = await db.rpc(staff, "aal1", "log_service", [db.branches.FAIRVIEW, today(), d2, 0, "SOLO", ana, null, null, null]);
    expect(log.ok).toBe(true);
    expect(await lines(log.id)).toEqual([{ role: "SOLO", a: 5000 }]);
    const plain = (await db.rpc(owner, "aal2", "save_service", [null, "DEMO Priced", 100000, 5000, true])).id;
    const unpaid = await db.rpc(staff, "aal1", "log_service", [db.branches.FAIRVIEW, today(), plain, 0, "SOLO", ana, null, null, null]);
    expect(await lines(unpaid.id)).toEqual([{ role: "SOLO", a: 0 }]); // a priced service with nothing paid earns nothing
  });
});
