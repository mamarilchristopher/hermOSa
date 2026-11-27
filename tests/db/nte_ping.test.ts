// update-0094: management pings an employee to explain a Late NTE. DEMO fixtures only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, ana: Person, bea: Person;
let anaE: string;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());

beforeAll(async () => {
  db = await TestDb.create();
  owner = await db.person("Owner", [["OWNER", null]]);
  ana = await db.person("Ana", [["CLINICIAN", "FAIRVIEW"]]);
  bea = await db.person("Bea", [["CLINICIAN", "FAIRVIEW"]]);
  anaE = (await db.rpc(owner, "aal2", "save_employee", [null, db.branches.FAIRVIEW, "DEMO Ana", "CMA", true, ana.appUserId, true])).id;
  await db.rpc(owner, "aal2", "save_employee", [null, db.branches.FAIRVIEW, "DEMO Bea", "CMA", true, bea.appUserId, true]);
}, 60_000);
afterAll(async () => db?.close());

const nte = async (day: string) => (await db.sql(
  `INSERT INTO public.late_ntes (organization_id, nte_no, employee_id, branch_id, work_date, shift_start, time_in, late_minutes, grace_minutes, respond_by)
   SELECT e.organization_id, coalesce((SELECT max(nte_no) FROM public.late_ntes), 0) + 1, e.id, e.branch_id, $2::date, '10:00', ($2 || ' 10:28:00+08')::timestamptz, 28, 15, $2::date + 2
   FROM public.employees e WHERE e.id = $1 RETURNING id`, [anaE, day])).rows[0].id as string;

describe("ping_nte", () => {
  it("sends the employee a reminder, counts pings, and stops once explained", async () => {
    const id = await nte(today());
    expect((await db.rpc(ana, "aal1", "ping_nte", [id])).ok).toBe(false); // not their own
    expect((await db.rpc(bea, "aal1", "ping_nte", [id])).ok).toBe(false); // coworkers can't
    const r = await db.rpc(owner, "aal2", "ping_nte", [id]);
    expect(r).toMatchObject({ ok: true, count: 1 });
    const note = (await db.sql("SELECT user_id, title, body, link FROM public.notifications WHERE kind = 'NTE_PING'")).rows;
    expect(note).toHaveLength(1);
    expect(note[0]).toMatchObject({ user_id: ana.appUserId, link: "/nte" });
    expect(note[0].body).toMatch(/NTE-\d{4}.*28 minutes late.*Explain by the end of/);
    expect((await db.rpc(owner, "aal2", "ping_nte", [id])).error).toBe("PINGED_RECENTLY");
    await db.sql("UPDATE public.late_ntes SET last_ping_at = now() - interval '11 minutes' WHERE id = $1", [id]);
    expect((await db.rpc(owner, "aal2", "ping_nte", [id])).count).toBe(2);
    const row = (await db.sql("SELECT ping_count, last_ping_by FROM public.late_ntes WHERE id = $1", [id])).rows[0];
    expect(row).toMatchObject({ ping_count: 2, last_ping_by: owner.appUserId });
    await db.rpc(ana, "aal1", "explain_nte", [id, "DEMO traffic", [`${id}/${randomUUID()}.jpg`]]);
    await db.sql("UPDATE public.late_ntes SET last_ping_at = NULL WHERE id = $1", [id]);
    expect((await db.rpc(owner, "aal2", "ping_nte", [id])).error).toBe("NOT_PENDING");
  });
});
