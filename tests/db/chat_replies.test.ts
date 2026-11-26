// update-0062: replies to a chat message. DEMO fixtures only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, ana: Person, bea: Person;
beforeAll(async () => {
  db = await TestDb.create();
  owner = await db.person("Owner", [["OWNER", null]]);
  ana = await db.person("Ana", [["CLINICIAN", "FAIRVIEW"]]);
  bea = await db.person("Bea", [["CLINICIAN", "FAIRVIEW"]]);
}, 60_000);
afterAll(async () => db?.close());

describe("chat replies", () => {
  it("a reply points at a message in the same chat; other chats' messages are refused", async () => {
    const dm = (await db.rpc(ana, "aal1", "chat_start_dm", [bea.appUserId])).id;
    const first = (await db.rpc(ana, "aal1", "chat_send", [dm, "DEMO hello", null, null])).message.id;
    const r = await db.rpc(bea, "aal1", "chat_send", [dm, "DEMO hi back", null, null, [], false, first]);
    expect(r.ok).toBe(true);
    expect(r.message.reply_to).toBe(first);
    const other = (await db.rpc(owner, "aal2", "chat_start_dm", [ana.appUserId])).id;
    expect((await db.rpc(ana, "aal1", "chat_send", [other, "DEMO x", null, null, [], false, first])).error).toBe("BAD_REQUEST");
    expect((await db.rpc(ana, "aal1", "chat_send", [dm, "DEMO plain", null, null, [], false])).message.reply_to).toBeNull();
  });

  it("management messages are labelled with the sender's first name, and opening the chat clears them", async () => {
    const dm = (await db.rpc(owner, "aal2", "chat_start_dm", [bea.appUserId])).id;
    await db.rpc(owner, "aal2", "chat_send", [dm, "DEMO from management", null, null]);
    const row = ((await db.rpc(bea, "aal1", "chat_list", [])) as { id: string; mgmt_unread: number; mgmt_from: string | null }[]).find((r) => r.id === dm)!;
    expect(row.mgmt_unread).toBe(1);
    expect(row.mgmt_from).toBe("DEMO"); // first word of the DEMO account name
    const notice = (await db.rpc(bea, "aal1", "chat_mgmt_unread", [])) as { sender_first: string }[];
    expect(notice[0].sender_first).toBe("DEMO"); // first word of the DEMO account name
    await db.rpc(bea, "aal1", "chat_mark_read", [dm]);
    const after = ((await db.rpc(bea, "aal1", "chat_list", [])) as { id: string; mgmt_unread: number; mgmt_from: string | null }[]).find((r) => r.id === dm)!;
    expect(after.mgmt_unread).toBe(0);
    expect(after.mgmt_from).toBeNull();
    expect(await db.rpc(bea, "aal1", "chat_mgmt_unread", [])).toEqual([]);
  });
});
