// update-0031: employees get a Home notice when management approves their details or commission. DEMO fixtures only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, gm: Person, fvManager: Person, staff: Person;
let ana: string, bea: string, svc: string;
const DEMO = { first_name: "Demo", last_name: "Staffer", birth_date: "1999-01-02", tin: "123456789", hire_date: "2024-03-01", consent: "yes" };
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());

beforeAll(async () => {
  db = await TestDb.create();
  owner = await db.person("Owner", [["OWNER", null]]);
  gm = await db.person("General Manager", [["MANAGER", null]]);
  fvManager = await db.person("Fairview Manager", [["MANAGER", "FAIRVIEW"]]);
  staff = await db.person("Fairview Staff", [["CLINICIAN", "FAIRVIEW"]]);
  const add = async (name: string, login: Person | null) =>
    (await db.rpc(owner, "aal2", "save_employee", [null, db.branches.FAIRVIEW, name, "Therapist", true, login?.appUserId ?? null, true])).id as string;
  ana = await add("DEMO Ana", staff);
  bea = await add("DEMO Bea", null);
  svc = (await db.rpc(fvManager, "aal1", "add_service", ["DEMO Facial"])).id;
}, 60_000);
afterAll(async () => db?.close());

const notices = async (p: Person, kind: string) =>
  (await db.sql("SELECT title, body, link, read_at FROM public.notifications WHERE user_id = $1 AND kind = $2 ORDER BY created_at", [p.appUserId, kind])).rows;

describe("approval notices", () => {
  it("staff details sent back, then approved", async () => {
    const sub = (await db.rpc(staff, "aal1", "submit_employee_details", [JSON.stringify(DEMO)])).id as string;
    expect((await db.rpc(gm, "aal1", "decide_employee_details", [sub, false, null, null, "DEMO fix the TIN"])).ok).toBe(true);
    expect((await notices(staff, "DETAILS_RETURNED"))[0].body).toContain("DEMO fix the TIN");
    const sub2 = (await db.rpc(staff, "aal1", "submit_employee_details", [JSON.stringify(DEMO)])).id as string;
    expect((await db.rpc(gm, "aal1", "decide_employee_details", [sub2, true, null, "DEMO Ana", null])).ok).toBe(true);
    const ok = await notices(staff, "DETAILS_APPROVED");
    expect(ok).toHaveLength(1);
    expect(ok[0].link).toBe("/me/details");
  });

  it("commission sign-off: one notice per day with the running approved amount", async () => {
    const log = async (paid: number) => (await db.rpc(fvManager, "aal1", "log_service", [db.branches.FAIRVIEW, today(), svc, paid, "LEAD", ana, bea, null, null])).id as string;
    const a = await log(1_000_000), b = await log(500_000);
    expect((await db.rpc(gm, "aal1", "decide_service_log", [a, true, null])).state).toBe("APPROVED");
    let n = await notices(staff, "COMMISSION_APPROVED");
    expect(n).toHaveLength(1);
    expect(n[0].body).toMatch(/^Your commission amounting to ₱300\.00 for \w{3} \d{1,2} has been approved and will be included in this cutoff's pay\.$/);
    expect(n[0].link).toMatch(new RegExp(`^/people/${ana}\\?month=\\d{4}-\\d{2}&d=\\d{4}-\\d{2}-\\d{2}$`));
    expect((await db.rpc(gm, "aal1", "decide_service_log", [b, true, null])).state).toBe("APPROVED");
    n = await notices(staff, "COMMISSION_APPROVED");
    expect(n).toHaveLength(1);
    expect(n[0].body).toContain("₱450.00");
    // Once read, the next sign-off starts a fresh notice.
    await db.sql("UPDATE public.notifications SET read_at = now() WHERE user_id = $1", [staff.appUserId]);
    const c = await log(100_000);
    await db.rpc(gm, "aal1", "decide_service_log", [c, true, null]);
    expect(await notices(staff, "COMMISSION_APPROVED")).toHaveLength(2);
  });

  it("an entry not approved tells the person why", async () => {
    const d = (await db.rpc(fvManager, "aal1", "log_service", [db.branches.FAIRVIEW, today(), svc, 200_000, "LEAD", ana, bea, null, null])).id as string;
    expect((await db.rpc(gm, "aal1", "decide_service_log", [d, false, "DEMO wrong service"])).state).toBe("REJECTED");
    expect((await notices(staff, "COMMISSION_REJECTED"))[0].body).toContain("DEMO wrong service");
  });
});
