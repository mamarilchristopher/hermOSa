// update-0058: group chat icons; groups without one list members' faces. DEMO fixtures only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, ana: Person, bea: Person, cy: Person;
type Row = { id: string; name: string; auto: boolean; kind: string; icon_path: string | null; face_ids: string[] | null };

beforeAll(async () => {
  db = await TestDb.create();
  owner = await db.person("Owner", [["OWNER", null]]);
  ana = await db.person("Ana", [["CLINICIAN", "FAIRVIEW"]]);
  bea = await db.person("Bea", [["CLINICIAN", "FAIRVIEW"]]);
  cy = await db.person("Cy", [["CLINICIAN", "MAIN"]]);
  for (const [p, b] of [[ana, "FAIRVIEW"], [bea, "FAIRVIEW"], [cy, "MAIN"]] as const)
    await db.rpc(owner, "aal2", "save_employee", [null, db.branches[b], p.name, "CMA", true, p.appUserId, true]);
}, 60_000);
afterAll(async () => db?.close());

const list = async (p: Person) => (await db.rpc(p, "aal1", "chat_list", [])) as Row[];

describe("chat icons", () => {
  it("made groups: only owners and the GM change the icon (update-0062); bad paths are refused", async () => {
    const g = (await db.rpc(ana, "aal1", "chat_create_group", ["DEMO Icons", [bea.appUserId, owner.appUserId]])).id;
    const row = (await list(ana)).find((r) => r.id === g)!;
    expect(row.icon_path).toBeNull();
    expect((await db.rpc(bea, "aal1", "chat_set_icon", [g, `${g}/${bea.appUserId}/icon.jpg`])).error).toBe("FORBIDDEN");
    expect((await db.rpc(cy, "aal1", "chat_set_icon", [g, `${g}/${cy.appUserId}/x.jpg`])).error).toBe("FORBIDDEN");
    const path = `${g}/${owner.appUserId}/icon.jpg`;
    expect((await db.rpc(owner, "aal2", "chat_set_icon", [g, `${g}/${bea.appUserId}/icon.jpg`])).error).toBe("BAD_REQUEST"); // not the owner's upload
    expect((await db.rpc(owner, "aal2", "chat_set_icon", [g, path])).ok).toBe(true);
    expect((await list(ana)).find((r) => r.id === g)!.icon_path).toBe(path);
    expect((await db.rpc(owner, "aal2", "chat_set_icon", [g, null])).ok).toBe(true);
  });

  it("automatic groups: only owners and the GM change the icon; 1-on-1 chats have none", async () => {
    const all = (await list(ana)).find((r) => r.auto && r.name === "All staff")!;
    expect(all.face_ids).toBeNull();
    expect((await db.rpc(ana, "aal1", "chat_set_icon", [all.id, `${all.id}/${ana.appUserId}/i.jpg`])).error).toBe("FORBIDDEN");
    expect((await db.rpc(owner, "aal2", "chat_set_icon", [all.id, `${all.id}/${owner.appUserId}/i.jpg`])).ok).toBe(true);
    const dm = (await db.rpc(ana, "aal1", "chat_start_dm", [bea.appUserId])).id;
    expect((await db.rpc(ana, "aal1", "chat_set_icon", [dm, `${dm}/${ana.appUserId}/i.jpg`])).error).toBe("FORBIDDEN");
  });
});
