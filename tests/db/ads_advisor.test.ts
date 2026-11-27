// update-0099 (CHRIS Nov 27): Ads advisor daily feed. Windsor's login writes one table only; the Ads page reads it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, gm: Person, staff: Person, finance: Person;

beforeAll(async () => {
  db = await TestDb.create();
  owner = await db.person("Owner", [["OWNER", null]]);
  gm = await db.person("General Manager", [["MANAGER", null]]);
  staff = await db.person("Fairview Staff", [["CLINICIAN", "FAIRVIEW"]]);
  finance = await db.person("Finance", [["FINANCE", null]]);
}, 60_000);
afterAll(async () => db?.close());

/** Run SQL as the Windsor login inside a transaction that is rolled back. */
async function asWindsor(text: string) {
  const c = await (db as any).pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL ROLE windsor_writer");
    await c.query("SET LOCAL search_path = ads_feed");
    return await c.query(text);
  } finally {
    await c.query("ROLLBACK");
    c.release();
  }
}
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());

describe("feed reader", () => {
  it("starts with the Oct 20 – Nov 27 data and each ad set's targeting", async () => {
    const { rows } = await db.sql("SELECT count(*)::int n, min(date)::text a, max(date)::text b, count(adset_targeting)::int t FROM ads_feed.meta_ads_daily WHERE _source = 'seed'");
    expect(rows[0]).toEqual({ n: 677, a: "2026-10-20", b: "2026-11-27", t: 8 });
  });

  it("management and finance read it; clinic staff can't", async () => {
    const r = await db.rpc(owner, "aal2", "ads_feed_rows", ["2026-10-01"]);
    expect(r.ok).toBe(true);
    expect(r.rows.length).toBeGreaterThan(0);
    expect(Object.keys(r.targeting).length).toBe(8);
    expect((await db.rpc(gm, "aal1", "ads_feed_rows", [null])).ok).toBe(true);
    expect((await db.rpc(finance, "aal2", "ads_feed_rows", [null])).ok).toBe(true);
    expect(await db.rpc(staff, "aal1", "ads_feed_rows", [null])).toEqual({ ok: false, error: "FORBIDDEN" });
    await expect(db.as(owner, "aal2", "SELECT * FROM ads_feed.meta_ads_daily")).rejects.toThrow();
  });

  it("a re-sent day: the newest copy wins; other pages are left out", async () => {
    const d = today();
    await db.sql(`INSERT INTO ads_feed.meta_ads_daily (date, actor_id, ad_id, ad_name, spend, _loaded_at) VALUES
      ($1, '103117851723422', 'demo-ad', 'DEMO ad', 100, now() - interval '1 hour'),
      ($1, '103117851723422', 'demo-ad', 'DEMO ad', 250, now()),
      ($1, '999', 'other-ad', 'DEMO resort ad', 900, now())`, [d]);
    const r = await db.rpc(owner, "aal2", "ads_feed_rows", [d]);
    expect(r.rows.filter((x: any) => x.aid === "demo-ad").map((x: any) => Number(x.sp))).toEqual([250]);
    expect(r.rows.some((x: any) => x.aid === "other-ad")).toBe(false);
    expect(r.last_date).toBe(d);
    await db.sql("DELETE FROM ads_feed.meta_ads_daily WHERE ad_id IN ('demo-ad', 'other-ad')");
  });
});

describe("Windsor login", () => {
  it("adds and updates feed rows", async () => {
    const r = await asWindsor(`INSERT INTO meta_ads_daily (date, actor_id, ad_id, spend) VALUES ('2026-11-28', '103117851723422', 'w1', '12.5') RETURNING _source`);
    expect(r.rows[0]._source).toBe("windsor");
    await expect(asWindsor(`UPDATE meta_ads_daily SET spend = 1 WHERE ad_id = 'nope'`)).resolves.toBeTruthy();
  });

  it("can't delete, create tables, or touch Hermosa OS data and functions", async () => {
    await expect(asWindsor("DELETE FROM meta_ads_daily")).rejects.toThrow(/permission denied/);
    await expect(asWindsor("CREATE TABLE ads_feed.x (a int)")).rejects.toThrow(/permission denied/);
    await expect(asWindsor("SELECT * FROM public.app_users")).rejects.toThrow(/permission denied/);
    await expect(asWindsor("SELECT * FROM public.service_logs")).rejects.toThrow(/permission denied/);
    await expect(asWindsor("SELECT public.ads_feed_rows(NULL)")).rejects.toThrow(/permission denied/);
    const { rows } = await db.sql(`SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.prosecdef AND has_schema_privilege('windsor_writer', n.oid, 'USAGE') AND has_function_privilege('windsor_writer', p.oid, 'EXECUTE')`);
    expect(rows[0].n).toBe(0);
    const role = (await db.sql("SELECT rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolinherit, rolpassword IS NULL nopw FROM pg_authid WHERE rolname = 'windsor_writer'")).rows[0];
    expect(role).toEqual({ rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false, rolinherit: false, nopw: true });
  });
});
