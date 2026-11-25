// update-0055: Hermosapp phone notifications. DEMO people and fake push addresses only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, ana: Person, bea: Person, cy: Person;
const P256 = "B" + "A".repeat(86);  // 87 chars, shaped like a real p256dh key
const AUTH = "abcdefghijklmnopqrstuv";

beforeAll(async () => {
  db = await TestDb.create();
  owner = await db.person("Owner", [["OWNER", null]]);
  ana = await db.person("Ana", [["CLINICIAN", "FAIRVIEW"]]);
  bea = await db.person("Bea", [["CLINICIAN", "FAIRVIEW"]]);
  cy = await db.person("Cy", [["CLINICIAN", "FAIRVIEW"]]);
}, 60_000);
afterAll(async () => db?.close());
const outbox = async () => (await db.sql("SELECT users, title, url FROM private.push_outbox ORDER BY id")).rows;

describe("push", () => {
  it("saves this device's push address; bad ones are refused", async () => {
    expect((await db.rpc(ana, "aal1", "push_subscribe", ["https://push.example/ana-1", P256, AUTH, "iPhone"])).ok).toBe(true);
    expect((await db.rpc(bea, "aal1", "push_subscribe", ["https://push.example/bea-1", P256, AUTH, "Android"])).ok).toBe(true);
    expect((await db.rpc(ana, "aal1", "push_subscribe", ["http://insecure.example/x", P256, AUTH, null])).error).toBe("BAD_REQUEST");
    expect((await db.rpc(ana, "aal1", "push_subscribe", ["https://push.example/x", "bad key", AUTH, null])).error).toBe("BAD_REQUEST");
    // nobody can read the addresses directly
    await expect(db.as(ana, "aal1", "SELECT * FROM public.push_subscriptions")).rejects.toThrow();
  });

  it("a chat message is pushed to the other members only", async () => {
    const dm = (await db.rpc(ana, "aal1", "chat_start_dm", [bea.appUserId])).id;
    await db.sql("DELETE FROM private.push_outbox");
    expect((await db.rpc(ana, "aal1", "chat_send", [dm, "DEMO hi", null, null])).ok).toBe(true);
    const o = await outbox();
    expect(o.length).toBe(1);
    expect(o[0].users).toEqual([bea.appUserId]);
    expect(o[0].url).toBe(`/chat/${dm}`);
    // Cy has no device saved: nothing to push
    const dm2 = (await db.rpc(ana, "aal1", "chat_start_dm", [cy.appUserId])).id;
    await db.rpc(ana, "aal1", "chat_send", [dm2, "DEMO hello", null, null]);
    expect((await outbox()).length).toBe(1);
  });

  it("new notices are pushed, except chat tag notices (the chat push covers them)", async () => {
    await db.sql("DELETE FROM private.push_outbox");
    await db.sql(`INSERT INTO public.notifications (organization_id, user_id, kind, title, link)
      SELECT organization_id, id, 'LEAVE_DECIDED', 'DEMO leave approved', '/leave' FROM public.app_users WHERE id = $1`, [ana.appUserId]);
    await db.sql(`INSERT INTO public.notifications (organization_id, user_id, kind, title, link)
      SELECT organization_id, id, 'CHAT_MENTION', 'DEMO tagged', '/chat/x' FROM public.app_users WHERE id = $1`, [ana.appUserId]);
    const o = await outbox();
    expect(o.map((x: { title: string }) => x.title)).toEqual(["DEMO leave approved"]);
  });

  it("gone addresses are removed only with the secret; turning off removes your own", async () => {
    expect((await db.rpc(owner, "aal2", "push_gone", ["wrong", ["https://push.example/bea-1"]])).error).toBe("FORBIDDEN");
    const secret = (await db.sql("SELECT value FROM private.app_settings WHERE key = 'push_secret'")).rows[0].value;
    expect(secret).toMatch(/^[0-9a-f]{48}$/);
    expect((await db.rpc(owner, "aal2", "push_gone", [secret, ["https://push.example/bea-1"]])).removed).toBe(1);
    expect((await db.rpc(bea, "aal1", "push_unsubscribe", ["https://push.example/ana-1"])).removed).toBe(0);
    expect((await db.rpc(ana, "aal1", "push_unsubscribe", ["https://push.example/ana-1"])).removed).toBe(1);
  });
});
