// update-0097 (CHRIS Nov 27): the phone's location at a clinic beats the branch picked at time in; today's Service log
// entries by staff must be at the branch where Done by / Assisted by timed in. DEMO fixtures only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, gm: Person, ana: Person, bea: Person, cy: Person;
let anaE: string, beaE: string, cyE: string, hiko: string, FV: string, MK: string, QC: string;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());
const photo = (p: Person) => `${p.appUserId}/${randomUUID()}.jpg`;

beforeAll(async () => {
  db = await TestDb.create();
  FV = db.branches.FAIRVIEW; MK = db.branches.MARIKINA; QC = db.branches.QC_MAIN;
  owner = await db.person("Owner", [["OWNER", null]]);
  gm = await db.person("General Manager", [["MANAGER", null]]);
  ana = await db.person("Ana", [["CLINICIAN", null]]);
  bea = await db.person("Bea", [["CLINICIAN", null]]);
  cy = await db.person("Cy", [["CLINICIAN", null]]);
  const add = async (name: string, who: Person) =>
    (await db.rpc(owner, "aal2", "save_employee", [null, FV, name, "CMA", true, who.appUserId, true])).id as string;
  anaE = await add("DEMO Ana", ana); beaE = await add("DEMO Bea", bea); cyE = await add("DEMO Cy", cy);
  hiko = (await db.rpc(owner, "aal2", "save_service", [null, "DEMO Hiko", 899900, 45000, true])).id;
  // DEMO clinic coordinates (QC and Fairview ~7 km apart).
  await db.sql("UPDATE public.branches SET lat = 14.640, lng = 121.057 WHERE id = $1", [QC]);
  await db.sql("UPDATE public.branches SET lat = 14.702, lng = 121.068 WHERE id = $1", [FV]);
  await db.sql("UPDATE public.branches SET lat = 14.659, lng = 121.112 WHERE id = $1", [MK]);
}, 60_000);
afterAll(async () => db?.close());

const log = (who: Person, branch: string, emp: string, partner: string | null = null) => {
  const folder = randomUUID();
  const pic = (k: string) => ({ kind: k, path: `${branch}/${folder}/${k.toLowerCase()}-${randomUUID()}.jpg`, thumb: null });
  return db.rpc(who, "aal1", "log_client_visit", [branch, today(), hiko, 899900, partner ? "LEAD" : "SOLO", emp, partner, null,
    "PAID", true, "DEMO Client", null, folder, JSON.stringify(["WAIVER", "WAIVER", "BEFORE", "AFTER"].map(pic)), false]);
};

describe("time in: location beats the pick", () => {
  it("picked Sta. Maria-like home branch, phone at QC Main: on record at QC Main", async () => {
    const r = await db.rpc(ana, "aal1", "clock_punch", ["IN", FV, photo(ana), 14.6401, 121.0571, 15]);
    expect(r).toMatchObject({ ok: true, branch_id: QC, moved: true });
    expect(r.distance_m).toBeLessThan(50);
  });
  it("no location: the pick stands", async () => {
    const r = await db.rpc(bea, "aal1", "clock_punch", ["IN", MK, photo(bea), null, null, null]);
    expect(r).toMatchObject({ ok: true, branch_id: MK, moved: false });
  });
  it("location far from every clinic: the pick stands and is flagged by distance", async () => {
    const r = await db.rpc(cy, "aal1", "clock_punch", ["IN", FV, photo(cy), 14.9, 121.3, 20]);
    expect(r).toMatchObject({ ok: true, branch_id: FV, moved: false });
    expect(r.distance_m).toBeGreaterThan(300);
  });
  it("staff_branches_today lists where everyone timed in", async () => {
    const m = await db.rpc(ana, "aal1", "staff_branches_today", []);
    expect(m[anaE]).toEqual([QC]);
    expect(m[beaE]).toEqual([MK]);
  });
});

describe("service log follows today's time-in", () => {
  it("staff can't log today's service at a branch the performer didn't time in at", async () => {
    await expect(log(ana, FV, anaE)).rejects.toThrow(/WRONG_BRANCH_TODAY/);
    expect((await log(ana, QC, anaE)).ok).toBe(true);
  });
  it("an assistant timed in elsewhere is refused too", async () => {
    await expect(log(ana, QC, anaE, beaE)).rejects.toThrow(/WRONG_BRANCH_TODAY/);
  });
  it("someone who hasn't timed in can still be logged; owners and the GM can log anywhere", async () => {
    await db.sql("DELETE FROM public.time_punches WHERE employee_id = $1", [cyE]);
    expect((await log(cy, FV, cyE)).ok).toBe(true);
    expect((await log(gm, FV, anaE)).ok).toBe(true);
  });
});
