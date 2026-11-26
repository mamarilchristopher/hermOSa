// update-0081: Sales follow-ups for Unresponsive bookings. DEMO fixtures only (no real clients).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, gm: Person, csr: Person, cma: Person;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const book = async () => {
  const r = await db.rpc(csr, "aal1", "save_booking", [null, "DEMO Client", null, "FACEBOOK", "Hiko", today(), null, db.branches.FAIRVIEW, null, null, false, null, null]);
  expect(r.ok).toBe(true);
  return r.id as string;
};
const row = async (id: string) => (await db.sql("SELECT status, appointment_date::text d, resched_count FROM public.bookings WHERE id = $1", [id])).rows[0];
const count = async (id: string) => (await db.sql("SELECT count(*)::int n FROM public.booking_followups WHERE booking_id = $1", [id])).rows[0].n;

beforeAll(async () => {
  db = await TestDb.create();
  owner = await db.person("Owner", [["OWNER", null]]);
  gm = await db.person("General Manager", [["MANAGER", null]]);
  csr = await db.person("Csr", [["CSR", null]]);
  cma = await db.person("Fairview CMA", [["CLINICIAN", "FAIRVIEW"]]);
}, 60_000);
afterAll(async () => db?.close());

describe("sales follow-ups", () => {
  it("only Unresponsive bookings, only bookers", async () => {
    const id = await book();
    expect(await db.rpc(gm, "aal1", "log_booking_followup", [id, "CALL", "STILL_UNRESPONSIVE", null, null])).toMatchObject({ ok: false, error: "NOT_UNRESPONSIVE" });
    expect((await db.rpc(cma, "aal1", "set_booking_status", [id, "UNRESPONSIVE", null, null])).ok).toBe(true);
    expect(await db.rpc(cma, "aal1", "log_booking_followup", [id, "CALL", "STILL_UNRESPONSIVE", null, null])).toMatchObject({ ok: false, error: "NOT_ALLOWED" });
    expect(await db.rpc(gm, "aal1", "log_booking_followup", [id, "PIGEON", "STILL_UNRESPONSIVE", null, null])).toMatchObject({ ok: false, error: "BAD_REQUEST" });
    // CMAs can't read the follow-up log.
    expect((await db.as(cma, "aal1", "SELECT count(*)::int n FROM public.booking_followups")).rows[0].n).toBe(0);
  });
  it("still unresponsive keeps it on the list and counts the follow-up", async () => {
    const id = await book();
    await db.rpc(cma, "aal1", "set_booking_status", [id, "UNRESPONSIVE", null, null]);
    expect(await db.rpc(gm, "aal1", "log_booking_followup", [id, "CALL", "STILL_UNRESPONSIVE", null, "DEMO no answer"])).toMatchObject({ ok: true });
    expect(await db.rpc(csr, "aal1", "log_booking_followup", [id, "FACEBOOK", "STILL_UNRESPONSIVE", null, null])).toMatchObject({ ok: true });
    expect(await row(id)).toMatchObject({ status: "UNRESPONSIVE" });
    expect(await count(id)).toBe(2);
  });
  it("rebooked moves it to the new date as Booked; cancelled cancels", async () => {
    const id = await book();
    await db.rpc(cma, "aal1", "set_booking_status", [id, "UNRESPONSIVE", null, null]);
    expect(await db.rpc(gm, "aal1", "log_booking_followup", [id, "CALL", "REBOOKED", null, null])).toMatchObject({ ok: false, error: "BOOKING_DATE" });
    const to = addDays(today(), 5);
    expect(await db.rpc(gm, "aal1", "log_booking_followup", [id, "CALL", "REBOOKED", to, null])).toMatchObject({ ok: true });
    expect(await row(id)).toEqual({ status: "BOOKED", d: to, resched_count: 1 });
    const id2 = await book();
    await db.rpc(cma, "aal1", "set_booking_status", [id2, "UNRESPONSIVE", null, null]);
    expect(await db.rpc(owner, "aal2", "log_booking_followup", [id2, "SMS", "CANCELLED", null, "DEMO not interested"])).toMatchObject({ ok: true });
    expect(await row(id2)).toMatchObject({ status: "CANCELLED" });
    expect(await db.rpc(gm, "aal1", "log_booking_followup", [id2, "CALL", "STILL_UNRESPONSIVE", null, null])).toMatchObject({ ok: false, error: "NOT_UNRESPONSIVE" });
  });
});
