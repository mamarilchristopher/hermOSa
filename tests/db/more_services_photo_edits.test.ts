// update-0093 (CHRIS Nov 27): several services in one Service log entry; photo changes on past entries wait for an
// owner's or the GM's approval, and replaced / removed photos stay in the client's folder as "old". DEMO fixtures only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, gm: Person, staff: Person, other: Person;
let ana: string, hiko: string, facial: string, lux: string;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());

beforeAll(async () => {
  db = await TestDb.create();
  owner = await db.person("Owner", [["OWNER", null]]);
  gm = await db.person("General Manager", [["MANAGER", null]]);
  staff = await db.person("Fairview Staff", [["CLINICIAN", "FAIRVIEW"]]);
  other = await db.person("Marikina Staff", [["CLINICIAN", "MARIKINA"]]);
  ana = (await db.rpc(owner, "aal2", "save_employee", [null, db.branches.FAIRVIEW, "DEMO Ana", "CMA", true, staff.appUserId, true])).id;
  hiko = (await db.rpc(owner, "aal2", "save_service", [null, "DEMO Hiko", 899900, 45000, true])).id;
  facial = (await db.rpc(owner, "aal2", "save_service", [null, "DEMO Facial", 150000, null, true])).id;
  lux = (await db.rpc(owner, "aal2", "save_service", [null, "DEMO Lux Promo", 0, null, true])).id;
}, 60_000);
afterAll(async () => db?.close());

const pic = (folder: string, k: string) => {
  const id = randomUUID();
  return { kind: k, path: `${db.branches.FAIRVIEW}/${folder}/${k.toLowerCase()}-${id}.jpg`, thumb: `${db.branches.FAIRVIEW}/${folder}/thumb-${id}.jpg` };
};
const visit = async () => {
  const folder = randomUUID();
  const r = await db.rpc(staff, "aal1", "log_client_visit", [db.branches.FAIRVIEW, today(), hiko, 899900, "SOLO", ana, null, null,
    "PAID", true, "DEMO Client Two", null, folder, JSON.stringify(["WAIVER", "WAIVER", "BEFORE", "AFTER"].map((k) => pic(folder, k))), false]);
  expect(r.ok).toBe(true);
  return { id: r.id as string, folder };
};
const live = async (log: string) => (await db.sql("SELECT id, kind, path FROM public.service_photos WHERE service_log_id = $1 AND archived_at IS NULL ORDER BY position", [log])).rows;

describe("several services in one entry", () => {
  it("each extra service is its own line of the visit, with the usual commission", async () => {
    const v = await visit();
    const r = await db.rpc(staff, "aal1", "log_extra_service", [v.id, facial, 150000, null]);
    expect(r).toMatchObject({ ok: true, state: "PENDING" });
    const row = (await db.sql("SELECT client_name, photo_folder::text f, photos_due, list_price_cents::int lp FROM public.service_logs WHERE id = $1", [r.id])).rows[0];
    expect(row).toEqual({ client_name: "DEMO Client Two", f: v.folder, photos_due: false, lp: 150000 });
    // No set commission: 5% of ₱1,500 = ₱75, all to the solo lead.
    expect((await db.sql("SELECT role, amount_cents::int a FROM public.commission_lines WHERE service_log_id = $1", [r.id])).rows).toEqual([{ role: "SOLO", a: 7500 }]);
    // A different price needs a reason; then a discount earns 5% of what was paid.
    expect(await db.rpc(staff, "aal1", "log_extra_service", [v.id, facial, 100000, null])).toMatchObject({ ok: false, error: "PRICE_NOTE_REQUIRED" });
    const d = await db.rpc(staff, "aal1", "log_extra_service", [v.id, facial, 100000, "DEMO loyalty discount"]);
    expect((await db.sql("SELECT amount_cents::int a FROM public.commission_lines WHERE service_log_id = $1", [d.id])).rows).toEqual([{ a: 5000 }]);
    // A set commission applies at the list price.
    const h = await db.rpc(staff, "aal1", "log_extra_service", [v.id, hiko, 899900, null]);
    expect((await db.sql("SELECT amount_cents::int a FROM public.commission_lines WHERE service_log_id = $1", [h.id])).rows).toEqual([{ a: 45000 }]);
    // Promo items (no price) and other people's entries can't be added this way.
    expect(await db.rpc(staff, "aal1", "log_extra_service", [v.id, lux, 100000, "x"])).toMatchObject({ ok: false, error: "UNKNOWN_SERVICE" });
    expect(await db.rpc(other, "aal1", "log_extra_service", [v.id, facial, 150000, null])).toMatchObject({ ok: false, error: "NOT_ALLOWED" });
  });
});

describe("photo changes on past entries", () => {
  it("staff ask; nothing changes until an owner or the GM approves; old photos move to Old", async () => {
    const v = await visit();
    const [w1, , b] = await live(v.id);
    const newWaiver = pic(v.folder, "WAIVER"), extra = pic(v.folder, "AFTER");
    const changes = [{ op: "REPLACE", photo: w1.id, path: newWaiver.path, thumb: newWaiver.thumb }, { op: "REMOVE", photo: b.id }, { op: "ADD", ...extra }];
    expect(await db.rpc(staff, "aal1", "request_photo_changes", [v.id, JSON.stringify(changes), ""])).toMatchObject({ ok: false, error: "REASON_REQUIRED" });
    expect(await db.rpc(other, "aal1", "request_photo_changes", [v.id, JSON.stringify(changes), "DEMO blurry"])).toMatchObject({ ok: false });
    const r = await db.rpc(staff, "aal1", "request_photo_changes", [v.id, JSON.stringify(changes), "DEMO blurry waiver"]);
    expect(r).toMatchObject({ ok: true, applied: false });
    expect((await live(v.id)).length).toBe(4);
    // Management is told (owner and GM), and only they decide.
    expect((await db.sql("SELECT count(*)::int n FROM public.notifications WHERE kind = 'PHOTO_CHANGE' AND user_id = ANY($1)", [[owner.appUserId, gm.appUserId]])).rows[0].n).toBe(2);
    expect(await db.rpc(staff, "aal1", "decide_photo_change", [r.id, true, null])).toMatchObject({ ok: false, error: "NOT_ALLOWED" });
    expect(await db.rpc(gm, "aal1", "decide_photo_change", [r.id, true, "DEMO ok"])).toMatchObject({ ok: true });
    expect(await db.rpc(owner, "aal2", "decide_photo_change", [r.id, true, null])).toMatchObject({ ok: false, error: "ALREADY_DECIDED" });
    const now = await live(v.id);
    expect(now.map((p) => p.path).sort()).toEqual([newWaiver.path, extra.path, ...now.filter((p) => ![newWaiver.path, extra.path].includes(p.path)).map((p) => p.path)].sort());
    expect(now.length).toBe(4); // 4 - 1 replaced + 1 new waiver - 1 removed + 1 added
    expect(now.find((p) => p.path === newWaiver.path)?.kind).toBe("WAIVER");
    const old = (await db.sql("SELECT id, archived_why FROM public.service_photos WHERE service_log_id = $1 AND archived_at IS NOT NULL ORDER BY archived_why", [v.id])).rows;
    expect(old).toEqual([{ id: b.id, archived_why: "REMOVED" }, { id: w1.id, archived_why: "REPLACED" }]);
    // The archive lists them apart, as "old".
    const f = (await db.rpc(gm, "aal1", "client_photo_folders", [today(), db.branches.FAIRVIEW, false])).find((x: { id: string }) => x.id === v.id);
    expect(f.photos.length).toBe(4);
    expect(f.old.map((p: { why: string }) => p.why).sort()).toEqual(["REMOVED", "REPLACED"]);
    // The person who asked is told.
    expect((await db.sql("SELECT title FROM public.notifications WHERE kind = 'PHOTO_CHANGE_DONE' AND user_id = $1", [staff.appUserId])).rows[0].title).toBe("Photo change approved");
  });

  it("a rejected request changes nothing; owners' own changes apply at once and management is told", async () => {
    const v = await visit();
    const [w1] = await live(v.id);
    const r = await db.rpc(staff, "aal1", "request_photo_changes", [v.id, JSON.stringify([{ op: "REMOVE", photo: w1.id }]), "DEMO wrong photo"]);
    expect(await db.rpc(owner, "aal2", "decide_photo_change", [r.id, false, "DEMO keep it"])).toMatchObject({ ok: true });
    expect((await live(v.id)).length).toBe(4);
    const o = await db.rpc(owner, "aal2", "request_photo_changes", [v.id, JSON.stringify([{ op: "REMOVE", photo: w1.id }]), "DEMO duplicate"]);
    expect(o).toMatchObject({ ok: true, applied: true });
    expect((await live(v.id)).length).toBe(3);
    expect((await db.sql("SELECT count(*)::int n FROM public.notifications WHERE kind = 'PHOTO_CHANGED' AND user_id = $1", [gm.appUserId])).rows[0].n).toBe(1);
    // A removed photo can't be removed again; paths must be in the entry's own folder.
    expect(await db.rpc(owner, "aal2", "request_photo_changes", [v.id, JSON.stringify([{ op: "REMOVE", photo: w1.id }]), "DEMO again"])).toMatchObject({ ok: false, error: "BAD_REQUEST" });
    const stray = pic(randomUUID(), "BEFORE");
    expect(await db.rpc(staff, "aal1", "request_photo_changes", [v.id, JSON.stringify([{ op: "ADD", ...stray }]), "DEMO stray"])).toMatchObject({ ok: false, error: "BAD_REQUEST" });
  });

  it("the requester can take back a waiting request; lists show it to the right people", async () => {
    const v = await visit();
    const [w1] = await live(v.id);
    const r = await db.rpc(staff, "aal1", "request_photo_changes", [v.id, JSON.stringify([{ op: "REMOVE", photo: w1.id }]), "DEMO oops"]);
    expect((await db.rpc(staff, "aal1", "entry_photos", [v.id])).pending).toMatchObject({ id: r.id, mine: true });
    expect((await db.rpc(gm, "aal1", "photo_change_list", [])).some((x: { id: string }) => x.id === r.id)).toBe(true);
    expect((await db.rpc(other, "aal1", "photo_change_list", [])).some((x: { id: string }) => x.id === r.id)).toBe(false);
    expect(await db.rpc(other, "aal1", "cancel_photo_change", [r.id])).toMatchObject({ ok: false });
    expect(await db.rpc(staff, "aal1", "cancel_photo_change", [r.id])).toMatchObject({ ok: true });
    expect(await db.rpc(gm, "aal1", "decide_photo_change", [r.id, true, null])).toMatchObject({ ok: false, error: "ALREADY_DECIDED" });
  });
});
