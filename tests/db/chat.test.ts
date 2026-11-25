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

describe("update-0050: everyone in from the start", () => {
  it("All staff and branch teams include people who never opened Chat; owners and the GM can add anyone, and it sticks", async () => {
    const newbie = await db.person("Dee", [["CLINICIAN", "FAIRVIEW"]]);
    await db.rpc(owner, "aal2", "save_employee", [null, db.branches.FAIRVIEW, newbie.name, "CMA", true, newbie.appUserId, true]);
    const rooms = (await db.rpc(owner, "aal2", "chat_list", [])) as { id: string; name: string; auto: boolean }[];
    const all = rooms.find((r) => r.name === "All staff")!;
    const members = (await db.rpc(owner, "aal2", "chat_room", [all.id])).members.map((m: { id: string }) => m.id);
    expect(members).toContain(newbie.appUserId); // Dee never opened Chat
    await db.rpc(owner, "aal2", "chat_send", [all.id, "DEMO welcome everyone", null, null]);
    expect(await db.rpc(newbie, "aal1", "chat_unread", [])).toBe(1);
    // add Cy (Main) to the Fairview team by hand
    const fv = rooms.find((r) => r.auto && r.name !== "All staff" && r.name.toLowerCase().includes("fairview"))!;
    expect((await db.rpc(ana, "aal1", "chat_add_members", [fv.id, [cy.appUserId]])).error).toBe("FORBIDDEN");
    expect((await db.rpc(owner, "aal2", "chat_can_add", [fv.id]))).toBe(true);
    expect((await db.rpc(ana, "aal1", "chat_can_add", [fv.id]))).toBe(false);
    expect((await db.rpc(owner, "aal2", "chat_add_members", [fv.id, [cy.appUserId]])).ok).toBe(true);
    await db.rpc(cy, "aal1", "chat_list", []); // a sync runs
    expect((await db.rpc(cy, "aal1", "chat_room", [fv.id])).ok).toBe(true);
  });
});

describe("update-0050: deleting conversations", () => {
  it("1-on-1: either person deletes it for both; groups: the maker or management; auto groups are only cleared", async () => {
    const dm = (await db.rpc(ana, "aal1", "chat_start_dm", [cy.appUserId])).id;
    await db.rpc(ana, "aal1", "chat_send", [dm, "DEMO hello", null, null]);
    expect(await db.rpc(bea, "aal1", "chat_delete_room", [dm])).toEqual({ ok: false, error: "FORBIDDEN" });
    expect(await db.rpc(cy, "aal1", "chat_can_delete", [dm])).toBe(true);
    expect((await db.rpc(cy, "aal1", "chat_delete_room", [dm])).ok).toBe(true);
    expect(await read(ana, dm)).toEqual([]);
    expect((await db.rpc(ana, "aal1", "chat_list", [])).some((r: { id: string }) => r.id === dm)).toBe(false);

    const g = (await db.rpc(ana, "aal1", "chat_create_group", ["DEMO Team B", [bea.appUserId, gm.appUserId]])).id;
    expect(await db.rpc(bea, "aal1", "chat_can_delete", [g])).toBe(false);
    expect(await db.rpc(gm, "aal1", "chat_can_delete", [g])).toBe(true);
    expect((await db.rpc(ana, "aal1", "chat_delete_room", [g])).ok).toBe(true);

    const all = ((await db.rpc(owner, "aal2", "chat_list", [])) as { id: string; name: string }[]).find((r) => r.name === "All staff")!.id;
    await db.rpc(ana, "aal1", "chat_send", [all, "DEMO hi all", null, null]);
    expect(await db.rpc(ana, "aal1", "chat_can_delete", [all])).toBe(false);
    expect(await db.rpc(owner, "aal2", "chat_delete_room", [all])).toEqual({ ok: true, cleared: true });
    expect(await read(ana, all)).toEqual([]);
    expect((await db.rpc(ana, "aal1", "chat_room", [all])).ok).toBe(true); // the group stays
  });
});

describe("update-0051: @mentions", () => {
  it("tags people in groups, @all for owners/GM only, bell notices and unread @ counts", async () => {
    const g = (await db.rpc(ana, "aal1", "chat_create_group", ["DEMO Tag test", [bea.appUserId, cy.appUserId, gm.appUserId]])).id;
    const r = await db.rpc(ana, "aal1", "chat_send", [g, "@DEMO Bea please check", null, null, [bea.appUserId, ana.appUserId, owner.appUserId], false]);
    expect(r.ok).toBe(true);
    expect(r.message.mentions).toEqual([bea.appUserId]); // not yourself, not outsiders
    expect((await db.rpc(ana, "aal1", "chat_send", [g, "@all hi", null, null, null, true])).error).toBe("ALL_NOT_ALLOWED");
    expect((await db.rpc(gm, "aal1", "chat_send", [g, "@all meeting at 6", null, null, null, true])).ok).toBe(true);
    const n = await db.sql("select title, link from public.notifications where kind = 'CHAT_MENTION' and user_id = $1 order by created_at", [bea.appUserId]);
    expect(n.rows.map((x) => x.title)).toEqual(["DEMO Ana tagged you in DEMO Tag test", "DEMO General Manager tagged everyone in DEMO Tag test"]);
    expect(n.rows[0].link).toBe(`/chat/${g}`);
    const row = ((await db.rpc(cy, "aal1", "chat_list", [])) as { id: string; mention_unread: number }[]).find((x) => x.id === g)!;
    expect(row.mention_unread).toBe(1);
    expect((await db.rpc(ana, "aal1", "chat_send", [g, "old style still works", null, null])).ok).toBe(true);
  });
});

describe("update-0051: View as shows chat counts only", () => {
  it("owners see how many unread (and from management) without the messages; staff can't", async () => {
    const dm = (await db.rpc(owner, "aal2", "chat_start_dm", [bea.appUserId])).id;
    await db.rpc(owner, "aal2", "chat_send", [dm, "DEMO test", null, null]);
    const v = await db.rpc(owner, "aal2", "view_as_chat", [bea.appUserId]);
    expect(v.ok).toBe(true);
    expect(v.mgmt_unread).toBeGreaterThanOrEqual(1);
    expect(Object.keys(v).sort()).toEqual(["mgmt_unread", "ok", "tagged_unread", "unread"]);
    expect((await db.rpc(ana, "aal1", "view_as_chat", [bea.appUserId])).ok).toBe(false);
  });
});
