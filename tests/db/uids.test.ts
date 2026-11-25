// update-0029: every staff record (ST-0001) and login account (AC-0001) has a unique UID. All data is DEMO.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestDb } from "./harness";

let db: TestDb;
beforeAll(async () => {
  db = await TestDb.create();
  await db.person("First Staff", [["CLINICIAN", "FAIRVIEW"]]);
  await db.person("Second Staff", [["MANAGER", null]]);
}, 60_000);
afterAll(async () => db?.close());

describe("record UIDs", () => {
  it("every account and staff record has a unique UID in the right format", async () => {
    const acc = (await db.sql("SELECT uid FROM public.app_users")).rows.map((r) => r.uid as string);
    const emp = (await db.sql("SELECT uid FROM public.employees")).rows.map((r) => r.uid as string);
    expect(acc.length).toBeGreaterThan(0);
    expect(acc.every((u) => /^AC-\d{4,}$/.test(u))).toBe(true);
    expect(emp.every((u) => /^ST-\d{4,}$/.test(u))).toBe(true);
    expect(new Set(acc).size).toBe(acc.length);
    expect(new Set(emp).size).toBe(emp.length);
  });

  it("a new account gets the next number", async () => {
    const before = (await db.sql("SELECT max(substr(uid, 4)::int) AS m FROM public.app_users")).rows[0].m as number;
    const p = await db.person("New Staff", [["CLINICIAN", "FAIRVIEW"]]);
    const { rows } = await db.sql("SELECT uid FROM public.app_users WHERE id = $1", [p.appUserId]);
    expect(rows[0].uid).toBe(`AC-${String(before + 1).padStart(4, "0")}`);
  });

  it("fills in existing records oldest first (as on the live site)", async () => {
    await db.sql("ALTER TABLE public.app_users ALTER COLUMN uid DROP NOT NULL; UPDATE public.app_users SET uid = NULL;");
    await db.sql(readFileSync("supabase/migrations/20261125000029_staff_uids.sql", "utf8"));
    const { rows } = await db.sql("SELECT uid FROM public.app_users ORDER BY created_at, id");
    expect(rows.map((r) => r.uid)).toEqual(rows.map((_, i) => `AC-${String(i + 1).padStart(4, "0")}`));
    const p = await db.person("After Backfill", [["CLINICIAN", "FAIRVIEW"]]);
    expect((await db.sql("SELECT uid FROM public.app_users WHERE id = $1", [p.appUserId])).rows[0].uid).toBe(`AC-${String(rows.length + 1).padStart(4, "0")}`);
  });

  it("running update-0029 twice changes nothing", async () => {
    const snap = async () => (await db.sql("SELECT id, uid FROM public.app_users UNION ALL SELECT id, uid FROM public.employees ORDER BY 1")).rows;
    const a = await snap();
    await db.sql(readFileSync("supabase/migrations/20261125000029_staff_uids.sql", "utf8"));
    expect(await snap()).toEqual(a);
  });
});
