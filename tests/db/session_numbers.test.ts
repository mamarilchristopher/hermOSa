// update-0064: session numbers on service log entries (1 by default, up to 15). DEMO fixtures only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, staff: Person;
let ana: string, svc: string;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());

beforeAll(async () => {
  db = await TestDb.create();
  owner = await db.person("Owner", [["OWNER", null]]);
  staff = await db.person("Fairview Staff", [["CLINICIAN", "FAIRVIEW"]]);
  ana = (await db.rpc(owner, "aal2", "save_employee", [null, db.branches.FAIRVIEW, "DEMO Ana", "CMA", true, staff.appUserId, true])).id;
  svc = (await db.rpc(owner, "aal2", "save_service", [null, "DEMO Gluta", 10000, 500, true])).id;
}, 60_000);
afterAll(async () => db?.close());

const args = (client: string) => {
  const folder = randomUUID();
  const list = ["WAIVER", "WAIVER", "BEFORE", "AFTER"].map((k) => {
    const id = randomUUID();
    return { kind: k, path: `${db.branches.FAIRVIEW}/${folder}/${k.toLowerCase()}-${id}.jpg`, thumb: `${db.branches.FAIRVIEW}/${folder}/thumb-${id}.jpg` };
  });
  return [db.branches.FAIRVIEW, today(), svc, 10000, "SOLO", ana, null, null, "PAID", true, client, null, folder, JSON.stringify(list), false];
};
const session = async (id: string) => (await db.sql("SELECT session_no FROM public.service_logs WHERE id = $1", [id])).rows[0].session_no;

describe("session numbers", () => {
  it("default to 1, take 1–15, and refuse anything else", async () => {
    const a = await db.rpc(staff, "aal1", "log_client_visit", args("DEMO Client A"));
    expect(await session(a.id)).toBe(1);
    const b = await db.rpc(staff, "aal1", "log_client_visit", [...args("DEMO Client B"), 3]);
    expect(b.ok).toBe(true);
    expect(await session(b.id)).toBe(3);
    expect((await db.rpc(staff, "aal1", "log_client_visit", [...args("DEMO Client C"), 16])).error).toBe("BAD_REQUEST");
    expect((await db.rpc(staff, "aal1", "log_client_visit", [...args("DEMO Client C"), 0])).error).toBe("BAD_REQUEST");
  });

  it("management entries (approved right away) keep their session number", async () => {
    const r = await db.rpc(owner, "aal2", "log_client_visit", [...args("DEMO Client D"), 15]);
    expect(r.ok).toBe(true);
    expect(r.state).toBe("APPROVED");
    expect(await session(r.id)).toBe(15);
    // The setting doesn't leak into a later entry in the same session.
    const n = await db.rpc(owner, "aal2", "log_client_visit", args("DEMO Client E"));
    expect(await session(n.id)).toBe(1);
  });
});
