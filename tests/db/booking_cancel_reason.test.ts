// update-0094: every Cancelled booking needs the client's reason (CHRIS Nov 27). DEMO fixtures only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let gm: Person, csr: Person, cma: Person;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());
const book = async () => (await db.rpc(csr, "aal1", "save_booking", [null, "DEMO Client", null, "FACEBOOK", "Hiko", today(), null, db.branches.FAIRVIEW, null, null, false, null, null])).id as string;
const row = async (id: string) => (await db.sql("SELECT status, cancel_reason FROM public.bookings WHERE id = $1", [id])).rows[0];

beforeAll(async () => {
  db = await TestDb.create();
  gm = await db.person("General Manager", [["MANAGER", null]]);
  csr = await db.person("Csr", [["CSR", null]]);
  cma = await db.person("Fairview CMA", [["CLINICIAN", "FAIRVIEW"]]);
}, 60_000);
afterAll(async () => db?.close());

describe("cancel reason", () => {
  it("Cancelled needs the client's reason, from Bookings and from follow-ups", async () => {
    const id = await book();
    expect(await db.rpc(csr, "aal1", "set_booking_status", [id, "CANCELLED", null, null])).toMatchObject({ ok: false, error: "CANCEL_REASON_REQUIRED" });
    expect(await db.rpc(csr, "aal1", "set_booking_status", [id, "CANCELLED", null, "  "])).toMatchObject({ ok: false, error: "CANCEL_REASON_REQUIRED" });
    expect((await row(id)).status).toBe("BOOKED");
    expect((await db.rpc(csr, "aal1", "set_booking_status", [id, "CANCELLED", null, "DEMO no budget yet"])).ok).toBe(true);
    expect(await row(id)).toEqual({ status: "CANCELLED", cancel_reason: "DEMO no budget yet" });

    const f = await book();
    await db.rpc(cma, "aal1", "set_booking_status", [f, "UNRESPONSIVE", null, null]);
    expect(await db.rpc(gm, "aal1", "log_booking_followup", [f, "CALL", "CANCELLED", null, null])).toMatchObject({ ok: false, error: "CANCEL_REASON_REQUIRED" });
    expect((await db.rpc(gm, "aal1", "log_booking_followup", [f, "CALL", "CANCELLED", null, "DEMO moved abroad"])).ok).toBe(true);
    expect(await row(f)).toEqual({ status: "CANCELLED", cancel_reason: "DEMO moved abroad" });
  });
  it("an old Cancelled booking without a reason can get one; only bookers", async () => {
    const id = await book();
    await db.sql("UPDATE public.bookings SET status = 'CANCELLED' WHERE id = $1", [id]); // cancelled before update-0094
    expect((await db.rpc(cma, "aal1", "set_booking_status", [id, "CANCEL_REASON", null, "DEMO sick"])).ok).toBe(false);
    expect(await db.rpc(csr, "aal1", "set_booking_status", [id, "CANCEL_REASON", null, "x"])).toMatchObject({ ok: false, error: "CANCEL_REASON_REQUIRED" });
    expect((await db.rpc(csr, "aal1", "set_booking_status", [id, "CANCEL_REASON", null, "DEMO sick"])).ok).toBe(true);
    expect(await row(id)).toEqual({ status: "CANCELLED", cancel_reason: "DEMO sick" });
    const open = await book();
    expect(await db.rpc(csr, "aal1", "set_booking_status", [open, "CANCEL_REASON", null, "DEMO sick"])).toMatchObject({ ok: false, error: "BAD_REQUEST" });
  });
});
