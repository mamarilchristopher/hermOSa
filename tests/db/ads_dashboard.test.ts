// update-0096 (CHRIS Nov 27): Business › Ads — monthly Meta spend per branch and service, and where each sale came from. DEMO fixtures only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, gm: Person, staff: Person, finance: Person;
let ana: string, hiko: string;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());

beforeAll(async () => {
  db = await TestDb.create();
  owner = await db.person("Owner", [["OWNER", null]]);
  gm = await db.person("General Manager", [["MANAGER", null]]);
  staff = await db.person("Fairview Staff", [["CLINICIAN", "FAIRVIEW"]]);
  finance = await db.person("Finance", [["FINANCE", null]]);
  ana = (await db.rpc(owner, "aal2", "save_employee", [null, db.branches.FAIRVIEW, "DEMO Ana", "CMA", true, staff.appUserId, true])).id;
  hiko = (await db.rpc(owner, "aal2", "save_service", [null, "DEMO Hiko", 899900, 45000, true])).id;
}, 60_000);
afterAll(async () => db?.close());

const visit = async (client: string) => {
  const folder = randomUUID();
  const pic = (k: string) => ({ kind: k, path: `${db.branches.FAIRVIEW}/${folder}/${k.toLowerCase()}-${randomUUID()}.jpg`, thumb: null });
  const r = await db.rpc(staff, "aal1", "log_client_visit", [db.branches.FAIRVIEW, today(), hiko, 899900, "SOLO", ana, null, null,
    "PAID", true, client, null, folder, JSON.stringify(["WAIVER", "WAIVER", "BEFORE", "AFTER"].map(pic)), false]);
  expect(r.ok).toBe(true);
  return r.id as string;
};
const row = (o: Record<string, unknown> = {}) => ({ month: "2026-12-01", branch: "FAIRVIEW", service: "HIKO", spend_cents: 5000000, messages: 1200, ...o });

describe("ad spend", () => {
  it("owners and the GM save monthly spend; saving again updates it", async () => {
    expect(await db.rpc(staff, "aal1", "save_ad_spend", [JSON.stringify([row()])])).toMatchObject({ ok: false });
    expect(await db.rpc(owner, "aal2", "save_ad_spend", [JSON.stringify([row(), row({ service: "GLUTA", spend_cents: 1000000, messages: 300 })])])).toEqual({ ok: true, saved: 2 });
    expect(await db.rpc(gm, "aal1", "save_ad_spend", [JSON.stringify([row({ spend_cents: 5500000, through: "2026-12-15" })])])).toEqual({ ok: true, saved: 1 });
    const { rows } = await db.sql("SELECT service, spend_cents::int s, messages, through::text t FROM public.ad_spend_monthly ORDER BY service");
    expect(rows).toEqual([{ service: "GLUTA", s: 1000000, messages: 300, t: null }, { service: "HIKO", s: 5500000, messages: 1200, t: "2026-12-15" }]);
  });

  it("a bad row saves nothing", async () => {
    for (const bad of [row({ branch: "NOPE" }), row({ service: "BOTOX" }), row({ month: "2026-12-05" }), row({ spend_cents: -1 }), row({ spend_cents: "12.5" })]) {
      expect(await db.rpc(owner, "aal2", "save_ad_spend", [JSON.stringify([row({ month: "2027-01-01" }), bad])])).toMatchObject({ ok: false, error: "BAD_ROW" });
    }
    expect((await db.sql("SELECT count(*)::int n FROM public.ad_spend_monthly WHERE month = '2027-01-01'")).rows[0].n).toBe(0);
    expect(await db.rpc(owner, "aal2", "save_ad_spend", [JSON.stringify([])])).toMatchObject({ ok: false, error: "BAD_REQUEST" });
  });

  it("management and finance can read it; clinic staff can't, and nobody writes the table directly", async () => {
    expect((await db.as(owner, "aal2", "SELECT * FROM public.ad_spend_monthly")).rowCount).toBe(2);
    expect((await db.as(gm, "aal1", "SELECT * FROM public.ad_spend_monthly")).rowCount).toBe(2);
    expect((await db.as(finance, "aal2", "SELECT * FROM public.ad_spend_monthly")).rowCount).toBe(2);
    expect((await db.as(staff, "aal1", "SELECT * FROM public.ad_spend_monthly")).rowCount).toBe(0);
    await expect(db.as(owner, "aal2", "DELETE FROM public.ad_spend_monthly")).rejects.toThrow();
  });
});

describe("sales sources", () => {
  let a: string, b: string, aNo: string;
  beforeAll(async () => {
    a = await visit("DEMO Client A");
    b = await visit("DEMO Client B");
    aNo = (await db.sql("SELECT log_no FROM public.service_logs WHERE id = $1", [a])).rows[0].log_no;
  });
  const sourceOf = async (id: string) => (await db.sql("SELECT source FROM public.service_log_sources WHERE service_log_id = $1", [id])).rows[0]?.source ?? null;

  it("owners set sources by SL number (any case) or entry id, and get back the numbers not found", async () => {
    const r = await db.rpc(owner, "aal2", "set_sales_sources", [JSON.stringify([{ log_no: aNo.toLowerCase(), source: "AD" }, { log: b, source: "WALK_IN" }, { log_no: "SL-0001-9999", source: "AD" }])]);
    expect(r).toEqual({ ok: true, saved: 2, missing: ["SL-0001-9999"] });
    expect(await sourceOf(a)).toBe("AD");
    expect(await sourceOf(b)).toBe("WALK_IN");
  });

  it("the GM changes and clears a source; staff can't set one; a wrong source saves nothing", async () => {
    expect(await db.rpc(gm, "aal1", "set_sales_sources", [JSON.stringify([{ log: a, source: "REFERRAL" }, { log: b, source: null }])])).toMatchObject({ ok: true, saved: 2 });
    expect(await sourceOf(a)).toBe("REFERRAL");
    expect(await sourceOf(b)).toBeNull();
    expect(await db.rpc(staff, "aal1", "set_sales_sources", [JSON.stringify([{ log: b, source: "AD" }])])).toMatchObject({ ok: false });
    expect(await db.rpc(owner, "aal2", "set_sales_sources", [JSON.stringify([{ log: b, source: "AD" }, { log: a, source: "TIKTOK" }])])).toMatchObject({ ok: false, error: "BAD_SOURCE" });
    expect(await sourceOf(b)).toBeNull();
  });

  it("only management and finance read sources", async () => {
    expect((await db.as(owner, "aal2", "SELECT * FROM public.service_log_sources")).rowCount).toBe(1);
    expect((await db.as(staff, "aal1", "SELECT * FROM public.service_log_sources")).rowCount).toBe(0);
  });
});
