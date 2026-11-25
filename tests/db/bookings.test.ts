// update-0040: CSR online bookings, branch visit lists and statuses. DEMO fixtures only (no real clients).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, gm: Person, csr: Person, fvCma: Person, mkCma: Person;
let FV: string, MK: string, id: string;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const book = (p: Person, lvl: "aal1" | "aal2", over: Partial<Record<string, unknown>> = {}) => {
  const a = { id: null, client: "DEMO Client", contact: "0917 000 0000", platform: "FACEBOOK", services: "Hiko", date: today(), time: null, branch: FV, dp: null, dpDate: null, follow: false, note: null, ...over };
  return db.rpc(p, lvl, "save_booking", [a.id, a.client, a.contact, a.platform, a.services, a.date, a.time, a.branch, a.dp, a.dpDate, a.follow, a.note]);
};

beforeAll(async () => {
  db = await TestDb.create();
  FV = db.branches.FAIRVIEW; MK = db.branches.MARIKINA;
  owner = await db.person("Owner", [["OWNER", null]]);
  gm = await db.person("General Manager", [["MANAGER", null]]);
  csr = await db.person("Csr", [["CSR", null]]);
  fvCma = await db.person("Fairview CMA", [["CLINICIAN", "FAIRVIEW"]]);
  mkCma = await db.person("Marikina CMA", [["CLINICIAN", "MARIKINA"]]);
}, 60_000);
afterAll(async () => db?.close());

describe("bookings", () => {
  it("CSRs, owners and the GM book; branch staff can't", async () => {
    const r = await book(csr, "aal1", { time: "15:00", dp: 50000 });
    expect(r.ok).toBe(true);
    id = r.id;
    expect((await book(gm, "aal1", { branch: MK, contact: null, client: "DEMO Walk" })).ok).toBe(true);
    expect((await book(owner, "aal2", { date: addDays(today(), 3) })).ok).toBe(true);
    expect((await book(fvCma, "aal1")).ok).toBe(false);
    expect((await book(csr, "aal1", { date: addDays(today(), -40) })).error).toBe("BOOKING_DATE");
    const row = (await db.sql("SELECT deposit_cents, deposit_date, status FROM public.bookings WHERE id = $1", [id])).rows[0];
    expect(row.deposit_cents).toBe(50000);
    expect(row.status).toBe("BOOKED");
  });

  it("each branch sees only its own visits; CSRs see all", async () => {
    const n = async (p: Person) => (await db.as(p, "aal1", "SELECT count(*)::int n FROM public.bookings")).rows[0].n;
    expect(await n(csr)).toBe(3);
    expect(await n(fvCma)).toBe(2);
    expect(await n(mkCma)).toBe(1);
  });

  it("branch staff mark Arrived / Done / Re-sched; only bookers cancel", async () => {
    expect((await db.rpc(fvCma, "aal1", "set_booking_status", [id, "ARRIVED", null, null])).ok).toBe(true);
    expect((await db.rpc(mkCma, "aal1", "set_booking_status", [id, "DONE", null, null])).error).toBe("NOT_FOUND");
    expect((await db.rpc(fvCma, "aal1", "set_booking_status", [id, "CANCELLED", null, null])).ok).toBe(false);
    expect((await db.rpc(fvCma, "aal1", "set_booking_status", [id, "DONE", null, "DEMO Hiko done"])).ok).toBe(true);
    const mk = (await db.sql("SELECT id FROM public.bookings WHERE branch_id = $1", [MK])).rows[0].id;
    expect((await db.rpc(mkCma, "aal1", "set_booking_status", [mk, "RESCHEDULED", null, null])).error).toBe("BOOKING_DATE");
    const to = addDays(today(), 4);
    expect((await db.rpc(mkCma, "aal1", "set_booking_status", [mk, "RESCHEDULED", to, "w/ dp"])).ok).toBe(true);
    const r = (await db.sql("SELECT status, appointment_date::text d, rescheduled_from::text f, resched_count FROM public.bookings WHERE id = $1", [mk])).rows[0];
    expect(r).toEqual({ status: "BOOKED", d: to, f: today(), resched_count: 1 });
    expect((await db.rpc(csr, "aal1", "set_booking_status", [mk, "CANCELLED", null, "DEMO changed mind"])).ok).toBe(true);
    expect((await db.rpc(csr, "aal1", "set_booking_status", [mk, "LOST", null, null])).error).toBe("BAD_REQUEST");
  });
});
