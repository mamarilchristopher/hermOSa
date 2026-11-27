// update-0091: promo payment options (installments, sessions follow payments), promo posts + All staff announcement,
// and the Arriving / Did not arrive booking statuses. DEMO fixtures only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, staff: Person, csr: Person;
let ana: string, arms: string;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());

beforeAll(async () => {
  db = await TestDb.create();
  owner = await db.person("Owner", [["OWNER", null]]);
  staff = await db.person("Fairview Staff", [["CLINICIAN", "FAIRVIEW"]]);
  csr = await db.person("Csr", [["CSR", null]]);
  ana = (await db.rpc(owner, "aal2", "save_employee", [null, db.branches.FAIRVIEW, "DEMO Ana", "CMA", true, staff.appUserId, true])).id;
  arms = (await db.rpc(owner, "aal2", "save_service", [null, "DEMO Hifu Arms", 300000, null, true])).id;
}, 60_000);
afterAll(async () => db?.close());

const visit = (o: { pc?: string | null; neu?: object | null; service: string; amount: number; client?: string }) => {
  const folder = randomUUID();
  const list = JSON.stringify(["WAIVER", "WAIVER", "BEFORE", "AFTER"].map((k) => ({ kind: k, path: `${db.branches.FAIRVIEW}/${folder}/${k.toLowerCase()}-${randomUUID()}.jpg`, thumb: null })));
  return db.rpc(staff, "aal1", "log_promo_visit", [o.pc ?? null, o.neu ? JSON.stringify(o.neu) : null, db.branches.FAIRVIEW, today(), o.service,
    o.amount, "SOLO", ana, null, null, o.client ?? "DEMO Client A", null, folder, list, false, null]);
};

describe("installments", () => {
  let id: string, parts: { service_id: string }[], pay: string, client: string;
  it("an installment bundle gets a payment line; only drafts change payment options", async () => {
    // HIFU Arms 5 + 1 = 6 sessions for ₱15,000, up to 3 payments.
    id = (await db.rpc(owner, "aal2", "save_promo", [null, "DEMO Sculpt Plan", null, JSON.stringify([{ service_id: arms, paid: 5, free: 1 }]), 1500000, 6, null, null, "MANUAL"])).id;
    expect(await db.rpc(owner, "aal2", "set_promo_payment", [id, "INSTALLMENT", 7])).toMatchObject({ ok: false, error: "BAD_REQUEST" });
    expect(await db.rpc(staff, "aal1", "set_promo_payment", [id, "INSTALLMENT", 3])).toMatchObject({ ok: false, error: "NOT_ALLOWED" });
    expect(await db.rpc(owner, "aal2", "set_promo_payment", [id, "INSTALLMENT", 3])).toMatchObject({ ok: true });
    const r = await db.rpc(owner, "aal2", "approve_promo", [id]);
    expect(r).toMatchObject({ ok: true });
    parts = r.parts;
    pay = (await db.sql("SELECT pay_service_id FROM public.promos WHERE id = $1", [id])).rows[0].pay_service_id;
    expect(pay).toBeTruthy();
    expect(await db.rpc(owner, "aal2", "set_promo_payment", [id, "FULL", null])).toMatchObject({ ok: false, error: "NOT_FOUND" });
  });

  it("a session can't start before a payment", async () => {
    expect(await visit({ neu: { promo_id: id, payments: 3 }, service: parts[0].service_id, amount: 0 }))
      .toMatchObject({ ok: false, error: "PROMO_PAY_FIRST", due: 250000 });
  });

  it("the first of 3 payments unlocks 2 of 6 sessions; the plan can't go over the promo's limit", async () => {
    const r = await visit({ neu: { promo_id: id, payments: 5 }, service: pay, amount: 500000 });
    expect(r).toMatchObject({ ok: true, new: true });
    client = r.promo_client;
    expect((await db.sql("SELECT payments FROM public.promo_clients WHERE id = $1", [client])).rows[0].payments).toBe(3);
    expect(await visit({ pc: client, service: parts[0].service_id, amount: 0 })).toMatchObject({ ok: true, session: 1 });
    expect(await visit({ pc: client, service: parts[0].service_id, amount: 0 })).toMatchObject({ ok: true, session: 2 });
    expect(await visit({ pc: client, service: parts[0].service_id, amount: 0 })).toMatchObject({ ok: false, error: "PROMO_PAY_FIRST", due: 250000 });
    expect(await visit({ pc: client, service: pay, amount: 500000 })).toMatchObject({ ok: true });
    expect(await visit({ pc: client, service: parts[0].service_id, amount: 0 })).toMatchObject({ ok: true, session: 3 });
  });

  it("Service log options carry the payment options and the client's plan", async () => {
    const o = await db.rpc(staff, "aal1", "promo_log_options", []);
    expect(o.promos.find((p: { id: string }) => p.id === id)).toMatchObject({ pay_options: "INSTALLMENT", max_payments: 3, sessions: 6 });
    expect(o.clients.find((c: { id: string }) => c.id === client)).toMatchObject({ payments: 3 });
  });

  it("a full-payment promo keeps the simple bundle (price on session 1)", async () => {
    const pid = (await db.rpc(owner, "aal2", "save_promo", [null, "DEMO Full Only", null, JSON.stringify([{ service_id: arms, paid: 3, free: 1 }]), 900000, 6, null, null, "MANUAL"])).id;
    expect(await db.rpc(owner, "aal2", "set_promo_payment", [pid, "FULL", null])).toMatchObject({ ok: true });
    await db.rpc(owner, "aal2", "approve_promo", [pid]);
    expect((await db.sql("SELECT pay_service_id FROM public.promos WHERE id = $1", [pid])).rows[0].pay_service_id).toBeNull();
  });
});

describe("promo posts", () => {
  let id: string, room: string, launch: string;
  it("management makes the posting calendar; CSRs are told and can see it", async () => {
    id = (await db.rpc(owner, "aal2", "save_promo", [null, "DEMO Glow Post", null, JSON.stringify([{ service_id: arms, paid: 2, free: 0 }]), 500000, 6, null, null, "MANUAL"])).id;
    const posts = [{ slot: "LAUNCH", due_on: today(), feed_path: `${id}/feed.jpg`, story_path: `${id}/story.jpg`, feed_caption: "F", story_caption: "S" },
      { slot: "LAST_DAY", due_on: today(), feed_path: null, story_path: `${id}/story-last-day.jpg`, feed_caption: null, story_caption: "L" }];
    expect(await db.rpc(owner, "aal2", "promo_post_ready", [id, JSON.stringify(posts), "P", "A", null])).toMatchObject({ ok: false, error: "PROMO_NOT_RUNNING" });
    await db.rpc(owner, "aal2", "approve_promo", [id]);
    // Make sure All staff exists with everyone in it.
    await db.rpc(owner, "aal2", "chat_list", []);
    await db.rpc(csr, "aal1", "chat_list", []);
    room = (await db.sql("SELECT id FROM public.chat_rooms WHERE auto_key = 'ALL'")).rows[0].id;
    expect(await db.rpc(owner, "aal2", "promo_post_ready", [id, JSON.stringify(posts), "P", "A", `${room}/${csr.appUserId}/x.jpg`])).toMatchObject({ ok: false, error: "BAD_REQUEST" });
    expect(await db.rpc(owner, "aal2", "promo_post_ready", [id, JSON.stringify([{ ...posts[0], story_path: "elsewhere/story.jpg" }]), "P", "A", null])).toMatchObject({ ok: false, error: "BAD_REQUEST" });
    expect(await db.rpc(staff, "aal1", "promo_post_ready", [id, JSON.stringify(posts), "P", "A", null])).toMatchObject({ ok: false, error: "NOT_ALLOWED" });
    expect(await db.rpc(owner, "aal2", "promo_post_ready", [id, JSON.stringify(posts), "Pricing", "📣 NEW PROMO", `${room}/${owner.appUserId}/feed-1.jpg`])).toMatchObject({ ok: true });
    const seen = await db.as(csr, "aal1", "SELECT slot, title FROM public.promo_posts WHERE promo_id = $1 ORDER BY slot", [id]);
    expect(seen.rows).toEqual([{ slot: "LAST_DAY", title: "DEMO Glow Post" }, { slot: "LAUNCH", title: "DEMO Glow Post" }]);
    expect((await db.as(staff, "aal1", "SELECT 1 FROM public.promo_posts", [])).rowCount).toBe(0);
    launch = seen.rows.length ? (await db.sql("SELECT id FROM public.promo_posts WHERE promo_id = $1 AND slot = 'LAUNCH'", [id])).rows[0].id : "";
    expect((await db.sql("SELECT count(*)::int n FROM public.notifications WHERE user_id = $1 AND kind = 'PROMO_POST'", [csr.appUserId])).rows[0].n).toBe(1);
  });

  it("marking the launch posted announces it once in All staff, from the approver, tagging everyone", async () => {
    expect(await db.rpc(staff, "aal1", "promo_post_done", [launch, "CSR", null])).toMatchObject({ ok: false, error: "NOT_ALLOWED" });
    expect(await db.rpc(csr, "aal1", "promo_post_done", [launch, "CSR", null])).toMatchObject({ ok: true, announced: true });
    expect(await db.rpc(csr, "aal1", "promo_post_done", [launch, "CSR", null])).toMatchObject({ ok: true, announced: false });
    const m = (await db.sql("SELECT sender_id, body, photo_path, mention_all, from_management FROM public.chat_messages WHERE room_id = $1", [room])).rows;
    expect(m).toEqual([{ sender_id: owner.appUserId, body: "📣 NEW PROMO", photo_path: `${room}/${owner.appUserId}/feed-1.jpg`, mention_all: true, from_management: true }]);
    expect((await db.sql("SELECT count(*)::int n FROM public.notifications WHERE user_id = $1 AND kind = 'CHAT_MENTION'", [csr.appUserId])).rows[0].n).toBe(1);
    expect((await db.sql("SELECT state, via, posted_by FROM public.promo_posts WHERE id = $1", [launch])).rows[0]).toEqual({ state: "POSTED", via: "CSR", posted_by: csr.appUserId });
  });

  it("remaking the calendar keeps posts already up", async () => {
    const posts = [{ slot: "LAUNCH", due_on: today(), feed_path: `${id}/feed2.jpg`, story_path: `${id}/story2.jpg` }, { slot: "REMINDER", due_on: today(), story_path: `${id}/story2.jpg` }];
    expect(await db.rpc(owner, "aal2", "promo_post_ready", [id, JSON.stringify(posts), "P", "A", null])).toMatchObject({ ok: true });
    const rows = (await db.sql("SELECT slot, state, story_path FROM public.promo_posts WHERE promo_id = $1 ORDER BY slot", [id])).rows;
    expect(rows).toEqual([{ slot: "LAUNCH", state: "POSTED", story_path: `${id}/story.jpg` }, { slot: "REMINDER", state: "READY", story_path: `${id}/story2.jpg` }]);
  });
});

describe("bookings: Arriving and Did not arrive", () => {
  it("CSRs mark Arriving; the branch closes it as Arrived or Did not arrive; no-shows go to follow-ups", async () => {
    const b = await db.rpc(csr, "aal1", "save_booking", [null, "DEMO Client", null, "FACEBOOK", "Hiko", today(), null, db.branches.FAIRVIEW, null, null, false, null, null]);
    expect(b.ok).toBe(true);
    expect(await db.rpc(csr, "aal1", "set_booking_status", [b.id, "ARRIVING", null, null])).toMatchObject({ ok: true });
    expect(await db.rpc(staff, "aal1", "set_booking_status", [b.id, "NO_SHOW", null, null])).toMatchObject({ ok: true });
    expect((await db.sql("SELECT status FROM public.bookings WHERE id = $1", [b.id])).rows[0].status).toBe("NO_SHOW");
    expect(await db.rpc(csr, "aal1", "log_booking_followup", [b.id, "CALL", "STILL_UNRESPONSIVE", null, null])).toMatchObject({ ok: true });
  });
});

describe("bookings → Service log", () => {
  it("the waiver name takes priority, and a logged sale links to the booking and marks it Done", async () => {
    const b = await db.rpc(csr, "aal1", "save_booking", [null, "DEMO Fb Name", null, "FACEBOOK", "Hifu Arms", today(), null, db.branches.FAIRVIEW, null, null, false, null, null]);
    await db.rpc(csr, "aal1", "set_booking_status", [b.id, "ARRIVING", null, null]);
    expect(await db.rpc(staff, "aal1", "set_booking_waiver", [b.id, "DEMO Real Name"])).toMatchObject({ ok: true, name: "DEMO Real Name" });
    const folder = randomUUID();
    const list = JSON.stringify(["WAIVER", "WAIVER", "BEFORE", "AFTER"].map((k) => ({ kind: k, path: `${db.branches.FAIRVIEW}/${folder}/${k.toLowerCase()}-${randomUUID()}.jpg`, thumb: null })));
    const log = await db.rpc(staff, "aal1", "log_client_visit", [db.branches.FAIRVIEW, today(), arms, 300000, "SOLO", ana, null, null, "PAID", true, "DEMO Real Name", null, folder, list, false]);
    expect(log.ok).toBe(true);
    expect(await db.rpc(csr, "aal1", "link_booking_log", [b.id, log.id])).toMatchObject({ ok: false, error: "NOT_FOUND" }); // not their entry
    expect(await db.rpc(staff, "aal1", "link_booking_log", [b.id, log.id])).toMatchObject({ ok: true });
    expect((await db.sql("SELECT status, waiver_name FROM public.bookings WHERE id = $1", [b.id])).rows[0]).toEqual({ status: "DONE", waiver_name: "DEMO Real Name" });
    // Changing the waiver name later updates the linked entry; the same name as Facebook clears it.
    await db.rpc(staff, "aal1", "set_booking_waiver", [b.id, "DEMO Fixed Name"]);
    expect((await db.sql("SELECT client_name FROM public.service_logs WHERE id = $1", [log.id])).rows[0].client_name).toBe("DEMO Fixed Name");
    expect(await db.rpc(staff, "aal1", "set_booking_waiver", [b.id, "demo fb name"])).toMatchObject({ ok: true, name: "DEMO Fb Name" });
  });
});

describe("approved entries and the booking link", () => {
  it("an owner's entry (approved right away) still links to its booking and takes the waiver name", async () => {
    const b = await db.rpc(csr, "aal1", "save_booking", [null, "DEMO Owner Fb", null, "FACEBOOK", "Hifu Arms", today(), null, db.branches.FAIRVIEW, null, null, false, null, null]);
    await db.rpc(csr, "aal1", "set_booking_status", [b.id, "ARRIVED", null, null]);
    await db.rpc(owner, "aal2", "set_booking_waiver", [b.id, "DEMO Owner Waiver"]);
    const log = await db.rpc(owner, "aal2", "log_client_visit", [db.branches.FAIRVIEW, today(), arms, 300000, "SOLO", ana, null, null, "PAID", true, "DEMO Owner Fb", null, randomUUID(), "[]", false]);
    expect(log).toMatchObject({ ok: true, state: "APPROVED" });
    expect(await db.rpc(owner, "aal2", "link_booking_log", [b.id, log.id])).toMatchObject({ ok: true });
    expect((await db.sql("SELECT client_name, booking_id FROM public.service_logs WHERE id = $1", [log.id])).rows[0]).toEqual({ client_name: "DEMO Owner Waiver", booking_id: b.id });
    // Anything else on an approved entry stays locked.
    await expect(db.sql("UPDATE public.service_logs SET amount_paid_cents = 1 WHERE id = $1", [log.id])).rejects.toThrow(/ALREADY_DECIDED/);
  });
});

describe("Service has before and after photo?", () => {
  const photos = (kinds: string[]) => {
    const folder = randomUUID();
    return { folder, list: JSON.stringify(kinds.map((k) => ({ kind: k, path: `${db.branches.FAIRVIEW}/${folder}/${k.toLowerCase()}-${randomUUID()}.jpg`, thumb: null }))) };
  };
  it("ticked (the default) needs before and after photos; unticked needs only the waiver", async () => {
    const a = photos(["WAIVER", "WAIVER"]);
    const base = (name: string, f: { folder: string; list: string }) => [db.branches.FAIRVIEW, today(), arms, 300000, "SOLO", ana, null, null, "PAID", true, name, null, f.folder, f.list, false];
    expect(await db.rpc(staff, "aal1", "log_client_visit", base("DEMO No Ba 1", a))).toMatchObject({ ok: false, error: "BEFORE_AFTER_REQUIRED" });
    expect(await db.rpc(staff, "aal1", "log_client_visit", [...base("DEMO No Ba 1", a), 1, true])).toMatchObject({ ok: false, error: "BEFORE_AFTER_REQUIRED" });
    const r = await db.rpc(staff, "aal1", "log_client_visit", [...base("DEMO No Ba 1", a), 1, false]);
    expect(r).toMatchObject({ ok: true, photos_due: false });
    expect((await db.sql("SELECT before_after, photos_due FROM public.service_logs WHERE id = $1", [r.id])).rows[0]).toEqual({ before_after: false, photos_due: false });
    // The waiver is still needed.
    expect(await db.rpc(staff, "aal1", "log_client_visit", [...base("DEMO No Ba 2", photos([])), 1, false])).toMatchObject({ ok: false, error: "WAIVER_PHOTOS_REQUIRED" });
    // A normal entry right after is back to needing photos (the setting doesn't stick).
    expect(await db.rpc(staff, "aal1", "log_client_visit", base("DEMO No Ba 3", photos(["WAIVER", "WAIVER"])))).toMatchObject({ ok: false, error: "BEFORE_AFTER_REQUIRED" });
  });
});
