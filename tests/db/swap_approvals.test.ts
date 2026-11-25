// update-0036: a swap with a coworker needs the coworker's OK first, then an owner or the GM. DEMO fixtures only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, gm: Person, fvManager: Person, ana: Person, bea: Person, cara: Person;
let anaE: string, beaE: string, caraE: string, FV: string;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const nextMonday = () => { let d = addDays(today(), 1); while (new Date(`${d}T00:00:00Z`).getUTCDay() !== 1) d = addDays(d, 1); return d; };
let mon: string, tue: string;

beforeAll(async () => {
  db = await TestDb.create();
  FV = db.branches.FAIRVIEW;
  owner = await db.person("Owner", [["OWNER", null]]);
  gm = await db.person("General Manager", [["MANAGER", null]]);
  fvManager = await db.person("Fairview Manager", [["MANAGER", "FAIRVIEW"]]);
  ana = await db.person("Ana", [["CLINICIAN", "FAIRVIEW"]]);
  bea = await db.person("Bea", [["CLINICIAN", "FAIRVIEW"]]);
  cara = await db.person("Cara", [["CLINICIAN", "FAIRVIEW"]]);
  const add = async (name: string, who: Person) =>
    (await db.rpc(owner, "aal2", "save_employee", [null, FV, name, "CMA", true, who.appUserId, true])).id as string;
  anaE = await add("DEMO Ana", ana); beaE = await add("DEMO Bea", bea); caraE = await add("DEMO Cara", cara);
  mon = nextMonday(); tue = addDays(mon, 1);
  // Ana off Mondays, Bea off Tuesdays, Cara off Mondays.
  await db.rpc(gm, "aal1", "save_schedule_pattern", [anaE, FV, [1], "10:00", "19:00"]);
  await db.rpc(gm, "aal1", "save_schedule_pattern", [beaE, FV, [2], "10:00", "19:00"]);
  await db.rpc(gm, "aal1", "save_schedule_pattern", [caraE, FV, [1], "10:00", "19:00"]);
  await db.rpc(gm, "aal1", "generate_week", [mon]);
  await db.rpc(gm, "aal1", "publish_week", [mon]);
}, 60_000);
afterAll(async () => db?.close());

const off = async (emp: string, d: string) => (await db.sql("SELECT is_off FROM public.shifts WHERE employee_id = $1 AND work_date = $2", [emp, d])).rows[0].is_off as boolean;
const kinds = async (p: Person) => (await db.sql("SELECT kind FROM public.notifications WHERE user_id = $1 ORDER BY created_at", [p.appUserId])).rows.map((r) => r.kind);

describe("day-off swaps", () => {
  let id: string;
  it("Ana asks to trade days off with Bea (Mon for Tue): only Bea is asked first", async () => {
    const r = await db.rpc(ana, "aal1", "request_schedule_change", ["SWAP", mon, beaE, tue, "DEMO appointment"]);
    expect(r.ok).toBe(true);
    id = r.id;
    expect(await kinds(bea)).toContain("SWAP_ASKED");
    expect(await kinds(owner)).not.toContain("SWAP_TO_APPROVE");
    // Same day already asked about: refused.
    expect((await db.rpc(ana, "aal1", "request_schedule_change", ["SWAP", mon, beaE, null, null])).error).toBe("SWAP_ALREADY_ASKED");
  });

  it("nobody can approve before Bea accepts; Cara can't answer for Bea", async () => {
    expect((await db.rpc(gm, "aal1", "decide_schedule_request", [id, true, null])).error).toBe("COWORKER_PENDING");
    expect((await db.rpc(cara, "aal1", "respond_schedule_swap", [id, true, null])).error).toBe("NOT_FOUND");
    const w = await db.rpc(bea, "aal1", "week_schedule", [mon]);
    expect(w.requests.find((x: { id: string }) => x.id === id)).toMatchObject({ can_respond: true, can_decide: false, coworker_state: "WAITING" });
  });

  it("after Bea accepts, owners and the GM are asked; a branch manager still can't approve", async () => {
    expect((await db.rpc(bea, "aal1", "respond_schedule_swap", [id, true, null])).ok).toBe(true);
    expect(await kinds(owner)).toContain("SWAP_TO_APPROVE");
    expect(await kinds(gm)).toContain("SWAP_TO_APPROVE");
    expect(await kinds(ana)).toContain("SWAP_ACCEPTED");
    expect((await db.rpc(fvManager, "aal1", "decide_schedule_request", [id, true, null])).ok).toBe(false);
    const w = await db.rpc(gm, "aal1", "week_schedule", [mon]);
    expect(w.requests.find((x: { id: string }) => x.id === id)).toMatchObject({ can_decide: true, coworker_state: "ACCEPTED", other_date: tue });
  });

  it("the owner approves: both days trade on both schedules and both are told", async () => {
    expect(await off(anaE, mon)).toBe(true);
    expect((await db.rpc(owner, "aal2", "decide_schedule_request", [id, true, null])).state).toBe("APPROVED");
    expect(await off(anaE, mon)).toBe(false);
    expect(await off(beaE, mon)).toBe(true);
    expect(await off(anaE, tue)).toBe(true);
    expect(await off(beaE, tue)).toBe(false);
    expect((await kinds(bea)).filter((k) => k === "SCHEDULE_CHANGED").length).toBeGreaterThan(0);
  });

  it("a coworker who declines ends the request", async () => {
    const r = await db.rpc(cara, "aal1", "request_schedule_change", ["SWAP", tue, anaE, null, null]);
    expect(r.ok).toBe(true);
    expect((await db.rpc(ana, "aal1", "respond_schedule_swap", [r.id, false, "DEMO can't that day"])).ok).toBe(true);
    expect((await db.sql("SELECT state, coworker_state FROM public.schedule_requests WHERE id = $1", [r.id])).rows[0]).toEqual({ state: "REJECTED", coworker_state: "DECLINED" });
    expect(await kinds(cara)).toContain("SWAP_DECLINED");
    expect((await db.rpc(owner, "aal2", "decide_schedule_request", [r.id, true, null])).error).toBe("NOT_PENDING");
  });

  it("the GM can't approve a swap they are part of; an owner can", async () => {
    const gmE = (await db.rpc(owner, "aal2", "save_employee", [null, FV, "DEMO GM", "General Manager", false, gm.appUserId, true])).id;
    await db.rpc(gm, "aal1", "save_schedule_pattern", [gmE, FV, [3], "10:00", "19:00"]);
    const next = addDays(mon, 7);
    await db.rpc(gm, "aal1", "generate_week", [next]);
    await db.rpc(gm, "aal1", "publish_week", [next]);
    const wed = addDays(next, 2);
    const r = await db.rpc(cara, "aal1", "request_schedule_change", ["SWAP", wed, gmE, null, null]);
    expect((await db.rpc(gm, "aal1", "respond_schedule_swap", [r.id, true, null])).ok).toBe(true);
    expect((await db.rpc(gm, "aal1", "decide_schedule_request", [r.id, true, null])).ok).toBe(false);
    expect((await db.rpc(owner, "aal2", "decide_schedule_request", [r.id, true, null])).state).toBe("APPROVED");
  });
});
