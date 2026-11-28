// update-0103: the account a payment went to, set on the whole visit; who may set it; guard allows only that. DEMO fixtures only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, staff: Person, other: Person;
let ana: string, svc: string, pack: string;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());

beforeAll(async () => {
  db = await TestDb.create();
  owner = await db.person("Owner", [["OWNER", null]]);
  staff = await db.person("Fairview Staff", [["CLINICIAN", "FAIRVIEW"]]);
  other = await db.person("Other Staff", [["CLINICIAN", "FAIRVIEW"]]);
  ana = (await db.rpc(owner, "aal2", "save_employee", [null, db.branches.FAIRVIEW, "DEMO Ana", "CMA", true, staff.appUserId, true])).id;
  svc = (await db.rpc(owner, "aal2", "save_service", [null, "DEMO Thread Lift", 900000, null, true])).id;
  pack = (await db.rpc(owner, "aal2", "save_service", [null, "DEMO Meds Package", 80000, 0, true])).id;
  await db.sql("UPDATE public.services SET is_meds = true WHERE id = $1", [pack]);
}, 60_000);
afterAll(async () => db?.close());

const visit = async () => {
  const folder = randomUUID();
  const list = ["WAIVER", "WAIVER", "BEFORE", "AFTER"].map((k) => ({ kind: k, path: `${db.branches.FAIRVIEW}/${folder}/${k.toLowerCase()}-${randomUUID()}.jpg`, thumb: null }));
  const v = await db.rpc(staff, "aal1", "log_client_visit", [db.branches.FAIRVIEW, today(), svc, 900000, "SOLO", ana, null, null,
    "PAID", true, "DEMO Client", null, folder, JSON.stringify(list), false]);
  const m = await db.rpc(staff, "aal1", "log_meds", [v.id, pack, false]);
  return { main: v.id as string, line: m.id as string };
};
const to = async (id: string) => (await db.sql("SELECT paid_to FROM public.service_logs WHERE id = $1", [id])).rows[0].paid_to;

describe("payment account", () => {
  it("the person who logged it sets it for the whole visit while pending", async () => {
    const v = await visit();
    expect(await db.rpc(staff, "aal1", "set_service_paid_to", [v.main, "bpi"])).toMatchObject({ ok: true, paid_to: "BPI", lines: 2 });
    expect([await to(v.main), await to(v.line)]).toEqual(["BPI", "BPI"]);
    expect(await db.rpc(other, "aal1", "set_service_paid_to", [v.main, "CASH"])).toMatchObject({ ok: false, error: "NOT_ALLOWED" });
    expect(await db.rpc(staff, "aal1", "set_service_paid_to", [v.main, "PAYPAL"])).toMatchObject({ ok: false, error: "BAD_ACCOUNT" });
  });

  it("after sign-off only owners / GM change it, also when asked on a merged line", async () => {
    const v = await visit();
    expect(await db.rpc(owner, "aal2", "approve_service_logs", [[v.main, v.line]])).toMatchObject({ ok: true });
    expect(await db.rpc(staff, "aal1", "set_service_paid_to", [v.main, "GCASH"])).toMatchObject({ ok: false, error: "NOT_ALLOWED" });
    expect(await db.rpc(owner, "aal2", "set_service_paid_to", [v.line, "MARIBANK"])).toMatchObject({ ok: true, id: v.main, lines: 2 });
    expect(await to(v.main)).toBe("MARIBANK");
  });

  it("the guard lets the flag change paid_to only", async () => {
    const v = await visit();
    await expect(db.sql(`BEGIN; SELECT set_config('hermosa.paid_to', 'on', true);
      UPDATE public.service_logs SET paid_to = 'CASH', amount_paid_cents = 1 WHERE id = '${v.main}'; COMMIT;`)).rejects.toThrow();
    await db.sql("ROLLBACK").catch(() => undefined);
    await expect(db.sql("UPDATE public.service_logs SET paid_to = 'BOGUS' WHERE id = $1", [v.main])).rejects.toThrow();
  });
});
