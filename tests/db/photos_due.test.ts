// update-0054: owners and the GM may log without photos; the lead and assist must add them. DEMO fixtures only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, gm: Person, staff: Person, other: Person, csr: Person;
let ana: string, bea: string, svc: string;
let timeIn: () => Promise<unknown>, timeOut: () => Promise<unknown>;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());

beforeAll(async () => {
  db = await TestDb.create({ timeClockRule: true });
  owner = await db.person("Owner", [["OWNER", null]]);
  gm = await db.person("General Manager", [["MANAGER", null]]);
  staff = await db.person("Fairview Staff", [["CLINICIAN", "FAIRVIEW"]]);
  other = await db.person("Other Staff", [["CLINICIAN", "FAIRVIEW"]]);
  csr = await db.person("Demo CSR", [["CSR", null]]);
  const add = async (name: string, login: Person) =>
    (await db.rpc(owner, "aal2", "save_employee", [null, db.branches.FAIRVIEW, name, "CMA", true, login.appUserId, true])).id as string;
  ana = await add("DEMO Ana", staff);
  bea = await add("DEMO Bea", other);
  const punch = (emp: string, user: string, kind: string) => db.sql(
    "INSERT INTO public.time_punches (organization_id, employee_id, user_id, branch_id, kind, work_date) SELECT organization_id, $1, $2, branch_id, $3, (now() AT TIME ZONE 'Asia/Manila')::date FROM public.employees WHERE id = $1",
    [emp, user, kind]);
  timeIn = () => punch(ana, staff.appUserId, "IN");
  timeOut = () => punch(ana, staff.appUserId, "OUT");
  svc = (await db.rpc(owner, "aal2", "save_service", [null, "DEMO Hiko", 899900, 45000, true])).id;
}, 60_000);
afterAll(async () => db?.close());

const photos = (folder: string, kinds: string[]) => kinds.map((k) => {
  const id = randomUUID();
  return { kind: k, path: `${db.branches.FAIRVIEW}/${folder}/${k.toLowerCase()}-${id}.jpg`, thumb: null };
});
const log = (who: Person, aal: "aal1" | "aal2", kinds: string[]) => {
  const folder = randomUUID();
  return db.rpc(who, aal, "log_client_visit", [db.branches.FAIRVIEW, today(), svc, 899900, "LEAD", ana, bea, null, "PAID", true,
    "DEMO Client Two", null, folder, JSON.stringify(photos(folder, kinds)), false]);
};

describe("photos due", () => {
  let id: string;
  it("only staff timed in today can add entries; owners and the GM always can", async () => {
    expect((await log(staff, "aal1", ["WAIVER", "WAIVER", "BEFORE", "AFTER"])).error).toBe("NOT_TIMED_IN");
    expect((await db.rpc(staff, "aal1", "can_log_services_now", []))).toBe(false);
    // the older entry points are blocked too
    await expect(db.rpc(staff, "aal1", "log_service", [db.branches.FAIRVIEW, today(), svc, 899900, "SOLO", ana, null, null, null])).rejects.toThrow(/NOT_TIMED_IN/);
    await timeIn();
    expect((await db.rpc(staff, "aal1", "can_log_services_now", []))).toBe(true);
    await timeOut();
    expect((await log(staff, "aal1", ["WAIVER", "WAIVER", "BEFORE", "AFTER"])).error).toBe("NOT_TIMED_IN");
    await timeIn();
    expect((await db.rpc(gm, "aal1", "can_log_services_now", []))).toBe(true);
  });

  it("staff still need the photos; owners and the GM can log without them", async () => {
    expect((await log(staff, "aal1", [])).error).toBe("WAIVER_PHOTOS_REQUIRED");
    const r = await log(gm, "aal1", []);
    expect(r).toMatchObject({ ok: true, photos_due: true });
    id = r.id;
    expect((await log(owner, "aal2", ["WAIVER", "WAIVER", "BEFORE", "AFTER"])).photos_due).toBe(false);
  });

  it("the lead and assist get an urgent notice and see it on Home", async () => {
    for (const p of [staff, other]) {
      const n = (await db.as(p, "aal1", "SELECT kind, link FROM public.notifications WHERE kind = 'PHOTOS_DUE'")).rows;
      expect(n.length).toBe(1);
      expect(n[0].link).toContain(`entry=${id}`);
      const due = await db.rpc(p, "aal1", "my_photos_due", []);
      expect(due.map((d: { id: string }) => d.id)).toEqual([id]);
    }
    expect((await db.as(csr, "aal1", "SELECT count(*)::int n FROM public.notifications WHERE kind = 'PHOTOS_DUE'")).rows[0].n).toBe(0);
  });

  it("commission is held from payroll until the photos are added", async () => {
    const def = (await db.sql("SELECT pg_get_functiondef('private.compute_payslip(uuid,uuid)'::regprocedure) d")).rows[0].d;
    expect(def).toContain("NOT l.photos_due");
  });

  it("the lead adds them after sign-off; the notice clears and the entry counts again", async () => {
    expect((await db.rpc(owner, "aal2", "decide_service_log", [id, true, null])).state).toBe("APPROVED");
    expect((await db.rpc(csr, "aal1", "add_visit_photos", [id, randomUUID(), JSON.stringify(photos(randomUUID(), ["BEFORE"]))])).ok).toBe(false);
    const folder = (await db.sql("SELECT photo_folder FROM public.service_logs WHERE id = $1", [id])).rows[0].photo_folder;
    const half = await db.rpc(staff, "aal1", "add_visit_photos", [id, folder, JSON.stringify(photos(folder, ["BEFORE", "AFTER"]))]);
    expect(half).toMatchObject({ ok: true, complete: false });
    // the folder is now fixed: a different one is refused
    expect((await db.rpc(other, "aal1", "add_visit_photos", [id, randomUUID(), JSON.stringify(photos(randomUUID(), ["WAIVER"]))])).error).toBe("BAD_REQUEST");
    const done = await db.rpc(other, "aal1", "add_visit_photos", [id, folder, JSON.stringify(photos(folder, ["WAIVER", "WAIVER"]))]);
    expect(done).toMatchObject({ ok: true, complete: true });
    expect((await db.sql("SELECT photos_due, state FROM public.service_logs WHERE id = $1", [id])).rows[0]).toEqual({ photos_due: false, state: "APPROVED" });
    expect((await db.as(staff, "aal1", "SELECT count(*)::int n FROM public.notifications WHERE kind = 'PHOTOS_DUE' AND read_at IS NULL")).rows[0].n).toBe(0);
    expect(await db.rpc(staff, "aal1", "my_photos_due", [])).toEqual([]);
  });
});
