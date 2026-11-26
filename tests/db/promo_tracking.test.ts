// update-0087: approved promos tracked per client, per-session commission scaled by the promo's discount. DEMO fixtures only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, staff: Person;
let ana: string, drip: string, facial: string, arms: string;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());

beforeAll(async () => {
  db = await TestDb.create();
  owner = await db.person("Owner", [["OWNER", null]]);
  staff = await db.person("Fairview Staff", [["CLINICIAN", "FAIRVIEW"]]);
  ana = (await db.rpc(owner, "aal2", "save_employee", [null, db.branches.FAIRVIEW, "DEMO Ana", "CMA", true, staff.appUserId, true])).id;
  drip = (await db.rpc(owner, "aal2", "save_service", [null, "DEMO Drip Single Session", 150000, 7500, true])).id;
  facial = (await db.rpc(owner, "aal2", "save_service", [null, "DEMO Signature facial", 100000, null, true])).id;
  arms = (await db.rpc(owner, "aal2", "save_service", [null, "DEMO Hifu Arms", 300000, null, true])).id;
}, 60_000);
afterAll(async () => db?.close());

const photos = () => {
  const folder = randomUUID();
  return { folder, list: JSON.stringify(["WAIVER", "WAIVER", "BEFORE", "AFTER"].map((k) => ({ kind: k, path: `${db.branches.FAIRVIEW}/${folder}/${k.toLowerCase()}-${randomUUID()}.jpg`, thumb: null }))) };
};
const visit = (o: { pc?: string | null; neu?: object | null; service: string; amount: number; client?: string; session?: number | null; date?: string }) => {
  const ph = photos();
  return db.rpc(staff, "aal1", "log_promo_visit", [o.pc ?? null, o.neu ? JSON.stringify(o.neu) : null, db.branches.FAIRVIEW, o.date ?? today(), o.service,
    o.amount, "SOLO", ana, null, null, o.client ?? "DEMO Client A", null, ph.folder, ph.list, false, o.session ?? null]);
};
const commission = async (id: string) => (await db.sql("SELECT coalesce(sum(amount_cents), 0)::int c FROM public.commission_lines WHERE service_log_id = $1", [id])).rows[0].c;
const promo = async (items: object[], price: number, months = 12) => {
  const id = (await db.rpc(owner, "aal2", "save_promo", [null, `DEMO Promo ${randomUUID().slice(0, 6)}`, null, JSON.stringify(items), price, months, null, null, "MANUAL"])).id;
  const r = await db.rpc(owner, "aal2", "approve_promo", [id]);
  expect(r).toMatchObject({ ok: true });
  return { id, parts: r.parts as { service_id: string; base_id: string; sessions: number; commission_cents: number }[],
    pay: (await db.sql("SELECT pay_service_id FROM public.promos WHERE id = $1", [id])).rows[0].pay_service_id as string | null };
};

describe("programs", () => {
  let p: Awaited<ReturnType<typeof promo>>, client: string;
  it("approving sets up a payment line and one item per service, commission scaled by the discount", async () => {
    // 4 drips (₱1,500) + 2 facials (₱1,000) = ₱8,000 of sessions for ₱6,000: 75%.
    p = await promo([{ service_id: drip, paid: 4, free: 0 }, { service_id: facial, paid: 2, free: 0 }], 600000);
    expect(p.parts.map((x) => x.commission_cents)).toEqual([5625, 3750]); // 75% of ₱75 set commission; 75% of 5% of ₱1,000
    const pay = (await db.sql("SELECT price_cents, commission_cents FROM public.services WHERE id = $1", [p.pay])).rows[0];
    expect(pay).toEqual({ price_cents: null, commission_cents: "0" });
  });

  it("a new client starts with their first payment, no commission on the payment", async () => {
    const r = await visit({ neu: { promo_id: p.id, contact: "0917", schedule: [{ d: today(), s: p.parts[0].service_id, n: 1 }, { d: "1999-01-01", s: p.parts[0].service_id, n: 2 }] }, service: p.pay!, amount: 300000 });
    expect(r).toMatchObject({ ok: true, new: true, payment: true });
    client = r.promo_client;
    expect(await commission(r.id)).toBe(0);
    const c = (await db.sql("SELECT schedule, ends_on > start_on AS later FROM public.promo_clients WHERE id = $1", [client])).rows[0];
    expect(c.schedule).toHaveLength(1); // the 1999 date is dropped
    expect(c.later).toBe(true);
    expect(await visit({ neu: { promo_id: p.id }, service: p.pay!, amount: 1000, client: "demo client a " })).toMatchObject({ ok: false, error: "PROMO_CLIENT_EXISTS", id: client });
  });

  it("sessions are numbered, pay the scaled commission, and stop when used up", async () => {
    for (let i = 1; i <= 4; i++) {
      const r = await visit({ pc: client, service: p.parts[0].service_id, amount: 0 });
      expect(r).toMatchObject({ ok: true, session: i, of: 4 });
      expect(await commission(r.id)).toBe(5625);
      expect((await db.sql("SELECT session_no, promo_client_id, client_name FROM public.service_logs WHERE id = $1", [r.id])).rows[0])
        .toEqual({ session_no: i, promo_client_id: client, client_name: "DEMO Client A" });
    }
    expect(await visit({ pc: client, service: p.parts[0].service_id, amount: 0 })).toMatchObject({ ok: false, error: "PROMO_USED_UP" });
    expect(await visit({ pc: client, service: p.parts[1].service_id, amount: 50000 })).toMatchObject({ ok: false, error: "PROMO_PAY_LINE" });
    expect(await visit({ pc: client, service: drip, amount: 0 })).toMatchObject({ ok: false, error: "NOT_PROMO_SERVICE" });
  });

  it("payments can't go over the promo price", async () => {
    expect(await visit({ pc: client, service: p.pay!, amount: 400000 })).toMatchObject({ ok: false, error: "PROMO_OVERPAID", balance: 300000 });
    expect(await visit({ pc: client, service: p.pay!, amount: 300000 })).toMatchObject({ ok: true });
  });

  it("staff see the client and sessions used in the Service log options", async () => {
    const o = await db.rpc(staff, "aal1", "promo_log_options", []);
    const c = o.clients.find((x: { id: string }) => x.id === client);
    expect(c).toMatchObject({ paid_cents: 600000, client: "DEMO Client A" });
    expect(c.used[p.parts[0].service_id]).toBe(4);
    expect((await db.rpc(staff, "aal1", "promo_client_card", [client])).logs).toHaveLength(6);
  });

  it("the last session closes the client's promo; an ended promo hides its items once nobody has sessions left", async () => {
    expect(await db.rpc(owner, "aal2", "end_promo", [p.id])).toMatchObject({ ok: true, active_clients: 1 });
    expect((await db.sql("SELECT active FROM public.services WHERE id = $1", [p.parts[1].service_id])).rows[0].active).toBe(true);
    await visit({ pc: client, service: p.parts[1].service_id, amount: 0 });
    const r = await visit({ pc: client, service: p.parts[1].service_id, amount: 0 });
    expect(r).toMatchObject({ ok: true, session: 2, of: 2 });
    expect((await db.sql("SELECT state FROM public.promo_clients WHERE id = $1", [client])).rows[0].state).toBe("DONE");
    expect((await db.sql("SELECT bool_or(active) a FROM public.services WHERE id = ANY($1)", [[p.pay, ...p.parts.map((x) => x.service_id)]])).rows[0].a).toBe(false);
  });
});

describe("bundles", () => {
  it("one-service bundles keep the price on session 1 and check the client's session number", async () => {
    // Hifu Arms 3+1 for ₱9,000 (worth ₱12,000): ₱150 × 75% = ₱112.50 per session.
    const b = await promo([{ service_id: arms, paid: 3, free: 1 }], 900000, 5);
    expect(b.pay).toBeNull();
    expect(b.parts[0].commission_cents).toBe(11250);
    const first = await visit({ neu: { promo_id: b.id }, service: b.parts[0].service_id, amount: 900000, client: "DEMO Client B", session: 1 });
    expect(first).toMatchObject({ ok: true, session: 1, of: 4 });
    expect(await commission(first.id)).toBe(11250);
    expect(await visit({ pc: first.promo_client, service: b.parts[0].service_id, amount: 0, session: 1 })).toMatchObject({ ok: false, error: "PROMO_SESSION", session: 2 });
    const free = await visit({ pc: first.promo_client, service: b.parts[0].service_id, amount: 0, session: 2 });
    expect(await commission(free.id)).toBe(11250);
  });

  it("expired and cancelled promos can't be logged; only owners and the GM extend or cancel", async () => {
    const b = await promo([{ service_id: arms, paid: 2, free: 0 }], 600000, 3);
    const first = await visit({ neu: { promo_id: b.id }, service: b.parts[0].service_id, amount: 600000, client: "DEMO Client C", session: 1 });
    await db.sql("UPDATE public.promo_clients SET ends_on = current_date - 2, start_on = current_date - 40 WHERE id = $1", [first.promo_client]);
    expect(await visit({ pc: first.promo_client, service: b.parts[0].service_id, amount: 0, session: 2 })).toMatchObject({ ok: false, error: "PROMO_EXPIRED" });
    expect(await db.rpc(staff, "aal1", "update_promo_client", [first.promo_client, "EXTEND", null, 1, null])).toMatchObject({ ok: false, error: "NOT_ALLOWED" });
    expect(await db.rpc(owner, "aal2", "update_promo_client", [first.promo_client, "EXTEND", null, 1, null])).toMatchObject({ ok: true });
    expect(await db.rpc(owner, "aal2", "update_promo_client", [first.promo_client, "CANCEL", null, null, null])).toMatchObject({ ok: true });
    expect(await visit({ pc: first.promo_client, service: b.parts[0].service_id, amount: 0, session: 2 })).toMatchObject({ ok: false, error: "PROMO_CLIENT_CLOSED" });
  });

  it("a failed log doesn't leave a half-started client", async () => {
    const b = await promo([{ service_id: arms, paid: 2, free: 1 }], 600000, 4);
    const r = await db.rpc(staff, "aal1", "log_promo_visit", [null, JSON.stringify({ promo_id: b.id }), db.branches.FAIRVIEW, today(), b.parts[0].service_id,
      600000, "SOLO", ana, null, null, "DEMO Client D", null, randomUUID(), "[]", false, 1]); // no photos: log_client_visit says no
    expect(r.ok).toBe(false);
    expect((await db.sql("SELECT count(*)::int n FROM public.promo_clients WHERE promo_id = $1", [b.id])).rows[0].n).toBe(0);
  });
});

describe("promos approved before update-0087", () => {
  it("a program's old item becomes its payment line", async () => {
    const id = (await db.rpc(owner, "aal2", "save_promo", [null, "DEMO Old Program", null, JSON.stringify([{ service_id: drip, paid: 2, free: 0 }, { service_id: facial, paid: 1, free: 0 }]), 300000, 6, null, null, "MANUAL"])).id;
    const old = (await db.rpc(owner, "aal2", "save_service", [null, "DEMO Old Program (program)", 300000, 15000, true])).id;
    await db.sql("UPDATE public.promos SET state = 'APPROVED', service_id = $2 WHERE id = $1", [id, old]);
    const r = (await db.sql("SELECT private.promo_setup($1, created_by) r FROM public.promos WHERE id = $1", [id])).rows[0].r;
    expect(r).toMatchObject({ ok: true, pay_service_id: old });
    expect((await db.sql("SELECT price_cents, commission_cents FROM public.services WHERE id = $1", [old])).rows[0]).toEqual({ price_cents: null, commission_cents: "0" });
  });
});
