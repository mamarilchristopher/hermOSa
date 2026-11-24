// The 4-digit PIN second step. All data is DEMO.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, gm: Person;
const canSeeSales = async (p: Person) =>
  (await db.rpc(p, "aal1", "daily_sales_status", ["2026-11-01", "2026-11-02"])).branches?.length ?? 0;

beforeAll(async () => {
  db = await TestDb.create();
  owner = await db.person("Owner", [["OWNER", null]]);
  gm = await db.person("General Manager", [["MANAGER", null]]);
}, 60_000);
afterAll(async () => db?.close());

describe("staff PIN", () => {
  it("without a PIN nothing changes", async () => {
    expect(await db.rpc(gm, "aal1", "my_pin_status", [])).toMatchObject({ has_pin: false, verified: true });
    expect(await canSeeSales(gm)).toBe(4);
  });

  it("only an owner (with 2-step) can set a PIN, 4 digits, never their own", async () => {
    expect((await db.rpc(gm, "aal1", "set_staff_pin", [owner.appUserId, "1234"])).error).toBe("FORBIDDEN");
    expect((await db.rpc(owner, "aal1", "set_staff_pin", [gm.appUserId, "1234"])).error).toBe("MFA_REQUIRED");
    expect((await db.rpc(owner, "aal2", "set_staff_pin", [gm.appUserId, "12a4"])).error).toBe("PIN_FORMAT");
    expect((await db.rpc(owner, "aal2", "set_staff_pin", [owner.appUserId, "1234"])).error).toBe("FORBIDDEN");
    expect((await db.rpc(owner, "aal2", "set_staff_pin", [gm.appUserId, "4821"])).state).toBe("SET");
    const { rows } = await db.sql("SELECT pin_hash FROM private.user_pins WHERE user_id = $1", [gm.appUserId]);
    expect(rows[0].pin_hash).not.toContain("4821");
    expect(await db.rpc(owner, "aal2", "staff_pin_list", [])).toEqual([gm.appUserId]);
  });

  it("with a PIN set, the database hides everything until the PIN is entered for this sign-in", async () => {
    expect(await db.rpc(gm, "aal1", "my_pin_status", [])).toMatchObject({ has_pin: true, verified: false });
    expect(await canSeeSales(gm)).toBe(0);
    expect((await db.rpc(gm, "aal1", "verify_my_pin", ["0000"])).error).toBe("PIN_WRONG");
    expect((await db.rpc(gm, "aal1", "verify_my_pin", ["4821"])).state).toBe("VERIFIED");
    expect(await canSeeSales(gm)).toBe(4);
    // A new sign-in session needs the PIN again.
    const fresh = { ...gm, sessionId: randomUUID() };
    expect(await canSeeSales(fresh)).toBe(0);
  });

  it("5 wrong tries lock the PIN for 15 minutes", async () => {
    const s = { ...gm, sessionId: randomUUID() };
    for (let i = 0; i < 4; i++) expect((await db.rpc(s, "aal1", "verify_my_pin", ["1111"])).error).toBe("PIN_WRONG");
    expect((await db.rpc(s, "aal1", "verify_my_pin", ["1111"])).error).toBe("PIN_LOCKED");
    expect((await db.rpc(s, "aal1", "verify_my_pin", ["4821"])).error).toBe("PIN_LOCKED");
    expect(await canSeeSales(s)).toBe(0);
    expect(await db.auditCount("PIN_FAILED")).toBeGreaterThanOrEqual(5);
  });

  it("an owner can remove the PIN", async () => {
    expect((await db.rpc(owner, "aal2", "set_staff_pin", [gm.appUserId, null])).state).toBe("REMOVED");
    expect(await canSeeSales({ ...gm, sessionId: randomUUID() })).toBe(4);
  });
});
