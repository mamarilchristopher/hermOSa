// update-0049: team chat. DEMO fixtures only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, gm: Person, ana: Person, bea: Person, cy: Person;

beforeAll(async () => {
  db = await TestDb.create();
  owner = await db.person("Owner", [["OWNER", null]]);
  gm = await db.person("General Manager", [["MANAGER", null]]);
  ana = await db.person("Ana", [["CLINICIAN", "FAIRVIEW"]]);
  bea = await db.person("Bea", [["CLINICIAN", "FAIRVIEW"]]);
  cy = await db.person("Cy", [["CLINICIAN", "MAIN"]]);
  for (const [p, b] of [[ana, "FAIRVIEW"], [bea, "FAIRVIEW"], [cy, "MAIN"]] as const)
    await db.rpc(owner, "aal2", "save_employee", [null, db.branches[b], p.name, "CMA", true, p.appUserId, true]);
}, 60_000);
afterAll(async () => db?.close());

const read = (who: Person, room: string) =>
  db.as(who, "aal1", "SELECT body FROM public.chat_messages WHERE room_id = $1 ORDER BY created_at", [room]).then((r) => r.rows.map((x) => x.body));

describe("team chat", () => {
  it("everyone gets All staff; branch groups hold the branch's staff plus owners and the GM", async () => {
    const names = async (p: Person) => ((await db.rpc(p, "aal1", "chat_list", [])) as { name: string }[]).map((r) => r.name).sort();
    const anaRooms = await names(ana);
    expect(anaRooms).toContain("All staff");
    expect(anaRooms.some((n) => n.endsWith(" team"))).toBe(true);
    expect(anaRooms.length).toBe(2);
    expect((await names(owner)).length).toBeGreaterThan(3); // All staff + every branch
    expect((await names(gm)).length).toBe((await names(owner)).length);
  });

  it("a 1-on-1 chat is private: the owner and GM can't read it, and nobody can send into a chat they're not in", async () => {
    const dm = await db.rpc(ana, "aal1", "chat_start_dm", [bea.appUserId]);
    expect(dm.ok).toBe(true);
    expect((await db.rpc(bea, "aal1", "chat_start_dm", [ana.appUserId])).id).toBe(dm.id); // same chat both ways
    expect((await db.rpc(ana, "aal1", "chat_send", [dm.id, " hi Bea ", null, null])).ok).toBe(true);
    expect(await read(bea, dm.id)).toEqual(["hi Bea"]);
    expect(await read(owner, dm.id)).toEqual([]);
    expect(await read(gm, dm.id)).toEqual([]);
    expect((await db.rpc(owner, "aal2", "chat_room", [dm.id])).ok).toBe(false);
    expect((await db.rpc(owner, "aal2", "chat_send", [dm.id, "hello", null, null])).error).toBe("FORBIDDEN");
    expect((await db.rpc(cy, "aal1", "chat_mark_read", [dm.id])).ok).toBe(false);
  });

  it("unread counts, seen, and deleting your own message only", async () => {
    const dm = (await db.rpc(ana, "aal1", "chat_start_dm", [bea.appUserId])).id;
    const sent = await db.rpc(ana, "aal1", "chat_send", [dm, "are you in today?", null, null]);
    expect(await db.rpc(bea, "aal1", "chat_unread", [])).toBe(2);
    const row = ((await db.rpc(bea, "aal1", "chat_list", [])) as { id: string; unread: number; last: { text: string } }[]).find((r) => r.id === dm)!;
    expect(row.unread).toBe(2);
    expect(row.last.text).toBe("are you in today?");
    await db.rpc(bea, "aal1", "chat_mark_read", [dm]);
    expect(await db.rpc(bea, "aal1", "chat_unread", [])).toBe(0);
    expect((await db.rpc(bea, "aal1", "chat_delete_message", [sent.message.id])).ok).toBe(false);
    expect((await db.rpc(ana, "aal1", "chat_delete_message", [sent.message.id])).ok).toBe(true);
    expect(await read(bea, dm)).toEqual(["hi Bea", null]);
  });

  it("groups: create, add, rename, leave; photos must be in the chat's folder under your own name", async () => {
    const g = await db.rpc(ana, "aal1", "chat_create_group", ["DEMO Lunch", [bea.appUserId]]);
    expect(g.ok).toBe(true);
    expect((await db.rpc(cy, "aal1", "chat_add_members", [g.id, [cy.appUserId]])).error).toBe("FORBIDDEN");
    expect((await db.rpc(bea, "aal1", "chat_add_members", [g.id, [cy.appUserId]])).ok).toBe(true);
    expect((await db.rpc(cy, "aal1", "chat_rename", [g.id, "DEMO Lunch club"])).ok).toBe(true);
    expect((await db.rpc(cy, "aal1", "chat_send", [g.id, null, `${g.id}/${cy.appUserId}/abc-123.jpg`, null])).ok).toBe(true);
    expect((await db.rpc(cy, "aal1", "chat_send", [g.id, null, `${g.id}/${ana.appUserId}/abc-123.jpg`, null])).error).toBe("BAD_REQUEST");
    expect((await db.rpc(cy, "aal1", "chat_send", [g.id, "", null, null])).error).toBe("EMPTY_MESSAGE");
    expect((await db.rpc(cy, "aal1", "chat_send", [g.id, null, null, "https://evil.example/x.gif"])).error).toBe("BAD_REQUEST");
    expect((await db.rpc(cy, "aal1", "chat_send", [g.id, null, null, "https://media2.giphy.com/media/abc/giphy.gif"])).ok).toBe(true);
    const room = await db.rpc(ana, "aal1", "chat_room", [g.id]);
    expect(room.name).toBe("DEMO Lunch club");
    expect(room.members.length).toBe(3);
    expect((await db.rpc(cy, "aal1", "chat_leave", [g.id])).ok).toBe(true);
    expect(await read(cy, g.id)).toEqual([]);
    const all = ((await db.rpc(ana, "aal1", "chat_list", [])) as { id: string; auto: boolean }[]).find((r) => r.auto)!;
    expect((await db.rpc(ana, "aal1", "chat_leave", [all.id])).error).toBe("FORBIDDEN");
  });
});

describe("messages from management", () => {
  it("are flagged, and staff get the can't-miss notice until they open the chat", async () => {
    const dm = (await db.rpc(gm, "aal1", "chat_start_dm", [cy.appUserId])).id;
    const sent = await db.rpc(gm, "aal1", "chat_send", [dm, "DEMO please come to the office", null, null]);
    expect(sent.message.from_management).toBe(true);
    const staffMsg = await db.rpc(cy, "aal1", "chat_send", [dm, "ok po", null, null]);
    expect(staffMsg.message.from_management).toBe(false);
    // sending marks the sender's own chat read, so post another one from the GM
    await db.rpc(gm, "aal1", "chat_send", [dm, "DEMO thank you", null, null]);
    const n = await db.rpc(cy, "aal1", "chat_mgmt_unread", []);
    expect(n.map((x: { text: string }) => x.text)).toEqual(["DEMO thank you"]);
    expect(n[0].sender).toBe("DEMO General Manager");
    const row = ((await db.rpc(cy, "aal1", "chat_list", [])) as { id: string; mgmt_unread: number; last: { mgmt: boolean } }[]).find((r) => r.id === dm)!;
    expect(row.mgmt_unread).toBe(1);
    expect(row.last.mgmt).toBe(true);
    await db.rpc(cy, "aal1", "chat_mark_read", [dm]);
    expect(await db.rpc(cy, "aal1", "chat_mgmt_unread", [])).toEqual([]);
    // owners don't get the notice for the GM's messages
    const od = (await db.rpc(gm, "aal1", "chat_start_dm", [owner.appUserId])).id;
    await db.rpc(gm, "aal1", "chat_send", [od, "DEMO hi", null, null]);
    expect(await db.rpc(owner, "aal2", "chat_mgmt_unread", [])).toEqual([]);
  });
});
