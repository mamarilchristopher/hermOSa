// update-0034: staff send a profile picture; owners and the GM approve it or send it back. DEMO fixtures only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, gm: Person, fvManager: Person, staff: Person;
const file = (p: Person, n = 1) => `${p.appUserId}/00000000-0000-4000-8000-00000000000${n}.jpg`;

beforeAll(async () => {
  db = await TestDb.create();
  owner = await db.person("Owner", [["OWNER", null]]);
  gm = await db.person("General Manager", [["MANAGER", null]]);
  fvManager = await db.person("Fairview Manager", [["MANAGER", "FAIRVIEW"]]);
  staff = await db.person("Staff", [["CLINICIAN", "FAIRVIEW"]]);
}, 60_000);
afterAll(async () => db?.close());

const photo = async (p: Person) => (await db.sql("SELECT photo_path FROM public.app_users WHERE id = $1", [p.appUserId])).rows[0].photo_path;
const pendingOf = async (p: Person) => (await db.sql("SELECT id FROM public.profile_photos WHERE user_id = $1 AND state = 'PENDING'", [p.appUserId])).rows[0]?.id as string;

describe("profile pictures", () => {
  it("staff can only send a photo from their own folder; owners and the GM are told", async () => {
    expect((await db.rpc(staff, "aal1", "submit_profile_photo", [file(gm)])).error).toBe("BAD_REQUEST");
    expect((await db.rpc(staff, "aal1", "submit_profile_photo", [file(staff)])).ok).toBe(true);
    const told = (await db.sql("SELECT user_id FROM public.notifications WHERE kind = 'PHOTO_SUBMITTED'")).rows.map((r) => r.user_id).sort();
    expect(told).toEqual([owner.appUserId, gm.appUserId].sort());
    // Sending again replaces the one still waiting.
    expect((await db.rpc(staff, "aal1", "submit_profile_photo", [file(staff, 2)])).ok).toBe(true);
    expect((await db.sql("SELECT count(*)::int n FROM public.profile_photos WHERE user_id = $1 AND state = 'PENDING'", [staff.appUserId])).rows[0].n).toBe(1);
  });

  it("staff see only their own; a branch manager can't approve", async () => {
    expect((await db.as(staff, "aal1", "SELECT count(*)::int n FROM public.profile_photos")).rows[0].n).toBe(2);
    expect((await db.as(fvManager, "aal1", "SELECT count(*)::int n FROM public.profile_photos")).rows[0].n).toBe(0);
    expect((await db.rpc(fvManager, "aal1", "decide_profile_photo", [await pendingOf(staff), true, null])).ok).toBe(false);
  });

  it("sent back needs a note and tells the person; approved becomes their picture", async () => {
    const id = await pendingOf(staff);
    expect((await db.rpc(gm, "aal1", "decide_profile_photo", [id, false, ""])).error).toBe("NOTE_REQUIRED");
    expect((await db.rpc(gm, "aal1", "decide_profile_photo", [id, false, "DEMO face not clear"])).ok).toBe(true);
    expect((await db.sql("SELECT body FROM public.notifications WHERE kind = 'PHOTO_RETURNED'")).rows[0].body).toContain("DEMO face not clear");
    expect(await photo(staff)).toBeNull();
    await db.rpc(staff, "aal1", "submit_profile_photo", [file(staff, 3)]);
    expect((await db.rpc(gm, "aal1", "decide_profile_photo", [await pendingOf(staff), true, null])).ok).toBe(true);
    expect(await photo(staff)).toBe(file(staff, 3));
    expect((await db.sql("SELECT count(*)::int n FROM public.notifications WHERE kind = 'PHOTO_APPROVED' AND user_id = $1", [staff.appUserId])).rows[0].n).toBe(1);
  });

  it("the GM's own photo needs an owner", async () => {
    await db.rpc(gm, "aal1", "submit_profile_photo", [file(gm)]);
    const id = await pendingOf(gm);
    expect((await db.rpc(gm, "aal1", "decide_profile_photo", [id, true, null])).error).toBe("SELF_APPROVAL_DENIED");
    expect((await db.rpc(owner, "aal2", "decide_profile_photo", [id, true, null])).ok).toBe(true);
    expect(await photo(gm)).toBe(file(gm));
  });
});
