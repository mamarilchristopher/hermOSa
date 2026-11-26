// update-0075: proof of payment on service log entries. DEMO fixtures only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, staff: Person, other: Person, outsider: Person;
let ana: string, svc: string, log: string;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());
const proof = (branch: string, folder: string) => ({ path: `${branch}/${folder}/proof-${randomUUID()}.jpg`, thumb: `${branch}/${folder}/thumb-${randomUUID()}.jpg` });

beforeAll(async () => {
  db = await TestDb.create();
  owner = await db.person("Owner", [["OWNER", null]]);
  staff = await db.person("Fairview Staff", [["CLINICIAN", "FAIRVIEW"]]);
  other = await db.person("Fairview Cashier", [["CASHIER", "FAIRVIEW"]]);
  outsider = await db.person("Marikina Staff", [["CLINICIAN", "MARIKINA"]]);
  ana = (await db.rpc(owner, "aal2", "save_employee", [null, db.branches.FAIRVIEW, "DEMO Ana", "CMA", true, staff.appUserId, true])).id;
  svc = (await db.rpc(owner, "aal2", "save_service", [null, "DEMO Facial", 100000, 5000, true])).id;
  const v = await db.rpc(owner, "aal2", "log_client_visit", [db.branches.FAIRVIEW, today(), svc, 100000, "SOLO", ana, null, null,
    "PAID", true, "DEMO Client", null, randomUUID(), "[]", false]);
  log = v.id;
}, 60_000);
afterAll(async () => db?.close());

describe("payment proofs", () => {
  it("branch staff attach proofs to an approved entry; others in another branch can't", async () => {
    const f = randomUUID();
    expect(await db.rpc(other, "aal1", "add_payment_proof", [log, JSON.stringify([proof(db.branches.FAIRVIEW, f)])])).toMatchObject({ ok: true, count: 1 });
    expect(await db.rpc(outsider, "aal1", "add_payment_proof", [log, JSON.stringify([proof(db.branches.FAIRVIEW, f)])])).toMatchObject({ ok: false });
    expect(await db.rpc(staff, "aal1", "add_payment_proof", [log, JSON.stringify([{ path: "x/y.jpg" }])])).toMatchObject({ ok: false, error: "BAD_REQUEST" });
    const many = Array.from({ length: 5 }, () => proof(db.branches.FAIRVIEW, f));
    expect(await db.rpc(staff, "aal1", "add_payment_proof", [log, JSON.stringify(many)])).toMatchObject({ ok: false, error: "TOO_MANY" });
  });
  it("the folder list shows it to management, the lead and the uploader, not to other staff", async () => {
    const month = today().slice(0, 8) + "01";
    const seen = async (p: Person, aal: "aal1" | "aal2") => (await db.rpc(p, aal, "payment_proof_folders", [month, null])) as { client: string; proofs: unknown[] }[];
    expect((await seen(owner, "aal2"))[0]).toMatchObject({ client: "DEMO Client" });
    expect((await seen(staff, "aal1")).length).toBe(1); // lead
    expect((await seen(other, "aal1")).length).toBe(1); // attached it
    expect((await seen(outsider, "aal1")).length).toBe(0);
  });
  it("only the uploader or management removes a proof", async () => {
    const id = (await db.sql("SELECT id FROM public.payment_proofs WHERE service_log_id = $1 LIMIT 1", [log])).rows[0].id;
    expect(await db.rpc(staff, "aal1", "remove_payment_proof", [id])).toMatchObject({ ok: false, error: "FORBIDDEN" });
    expect(await db.rpc(owner, "aal2", "remove_payment_proof", [id])).toMatchObject({ ok: true });
  });
});
