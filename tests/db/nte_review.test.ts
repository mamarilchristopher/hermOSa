// update-0067: management accepts or rejects a Late NTE explanation. DEMO fixtures only.
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

const nte = async (day: string, minutes: number) => (await db.sql(
  `INSERT INTO public.late_ntes (organization_id, nte_no, employee_id, branch_id, work_date, shift_start, time_in, late_minutes, grace_minutes)
   SELECT e.organization_id, coalesce((SELECT max(nte_no) FROM public.late_ntes), 0) + 1, e.id, e.branch_id, $2::date, '10:00', ($2 || ' 10:' || $3 || ':00+08')::timestamptz, $3::int, 15
   FROM public.employees e WHERE e.id = $1 RETURNING id`, [anaE, day, String(minutes).padStart(2, "0")])).rows[0].id as string;
const explain = (id: string) => db.rpc(ana, "aal1", "explain_nte", [id, "DEMO hirap mag-book", [`${id}/${randomUUID()}.jpg`]]);
const month = today().slice(0, 7);

describe("review_nte", () => {
  it("accepting takes the NTE out of the IR; rejecting keeps it in", async () => {
    const a = await nte(`${month}-01`, 20), b = await nte(`${month}-02`, 30);
    expect((await db.rpc(owner, "aal2", "review_nte", [a, true, null])).error).toBe("NOT_PENDING"); // not explained yet
    await explain(a); await explain(b);
    expect((await db.rpc(bea, "aal1", "review_nte", [a, true, null])).ok).toBe(false);
    expect((await db.rpc(ana, "aal1", "review_nte", [a, true, null])).ok).toBe(false); // not their own
    expect((await db.rpc(owner, "aal2", "review_nte", [a, true, "DEMO screenshot shows 9:20 AM"])).state).toBe("ACCEPTED");
    expect((await db.rpc(owner, "aal2", "review_nte", [b, false, null])).state).toBe("EXPLAINED");
    const list = await db.rpc(owner, "aal2", "late_nte_list", [`${month}-01`, anaE]);
    expect(list.ntes.find((n: { id: string }) => n.id === a)).toMatchObject({ state: "ACCEPTED", review: "ACCEPTED", review_note: "DEMO screenshot shows 9:20 AM" });
    expect(list.ntes.find((n: { id: string }) => n.id === b)).toMatchObject({ state: "EXPLAINED", review: "REJECTED" });
    const note = await db.sql("SELECT count(*)::int n FROM public.notifications WHERE kind = 'NTE_REVIEWED'");
    expect(note.rows[0].n).toBe(2);
    const ir = await db.rpc(owner, "aal2", "issue_late_ir", [anaE, `${month}-01`, null]);
    expect(ir.ok).toBe(true);
    const rows = (await db.sql("SELECT id, ir_id FROM public.late_ntes WHERE employee_id = $1", [anaE])).rows;
    expect(rows.find((r) => r.id === a).ir_id).toBeNull();
    expect(rows.find((r) => r.id === b).ir_id).toBe(ir.id);
    expect((await db.rpc(owner, "aal2", "review_nte", [b, true, null])).error).toBe("NOT_PENDING"); // already in an IR
  });
});
