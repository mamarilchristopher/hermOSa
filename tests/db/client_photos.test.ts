// update-0053: client name, price notes and photos on a logged visit; client archive and social media folders. DEMO fixtures only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, gm: Person, staff: Person, qcStaff: Person, csr: Person;
let ana: string, svc: string;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());

beforeAll(async () => {
  db = await TestDb.create();
  owner = await db.person("Owner", [["OWNER", null]]);
  gm = await db.person("General Manager", [["MANAGER", null]]);
  staff = await db.person("Fairview Staff", [["CLINICIAN", "FAIRVIEW"]]);
  qcStaff = await db.person("QC Staff", [["CLINICIAN", "QC_MAIN"]]);
  csr = await db.person("Demo CSR", [["CSR", null]]);
  ana = (await db.rpc(owner, "aal2", "save_employee", [null, db.branches.FAIRVIEW, "DEMO Ana", "CMA", true, staff.appUserId, true])).id;
  svc = (await db.rpc(owner, "aal2", "save_service", [null, "DEMO Hiko", 899900, 45000, true])).id;
}, 60_000);
afterAll(async () => db?.close());

const photos = (folder: string, kinds: string[]) => kinds.map((k) => {
  const id = randomUUID();
  return { kind: k, path: `${db.branches.FAIRVIEW}/${folder}/${k.toLowerCase()}-${id}.jpg`, thumb: `${db.branches.FAIRVIEW}/${folder}/thumb-${id}.jpg` };
});
const FULL = ["WAIVER", "WAIVER", "BEFORE", "AFTER"];
const visit = (who: Person, o: { amount?: number; client?: string | null; note?: string | null; kinds?: string[]; share?: boolean; kind?: string; folder?: string; list?: unknown[] } = {}) => {
  const folder = o.folder ?? randomUUID();
  return db.rpc(who, "aal1", "log_client_visit", [db.branches.FAIRVIEW, today(), svc, o.amount ?? 899900, "SOLO", ana, null, null,
    o.kind ?? "PAID", true, o.client === undefined ? "DEMO Client One" : o.client, o.note ?? null, folder,
    JSON.stringify(o.list ?? photos(folder, o.kinds ?? FULL)), o.share ?? false]);
};
const lines = async (log: string) =>
  (await db.sql("SELECT role, amount_cents::int a FROM public.commission_lines WHERE service_log_id = $1", [log])).rows;

describe("log_client_visit", () => {
  let shared: string;
  it("logs the visit with the client's name and photos; the set commission applies at the list price", async () => {
    const r = await visit(staff, { share: true });
    expect(r).toMatchObject({ ok: true, state: "PENDING" });
    shared = r.id;
    const row = (await db.sql("SELECT client_name, list_price_cents::int lp, share_ok FROM public.service_logs WHERE id = $1", [r.id])).rows[0];
    expect(row).toEqual({ client_name: "DEMO Client One", lp: 899900, share_ok: true });
    expect((await db.sql("SELECT count(*)::int n FROM public.service_photos WHERE service_log_id = $1", [r.id])).rows[0].n).toBe(4);
    expect(await lines(r.id)).toEqual([{ role: "SOLO", a: 45000 }]);
  });

  it("needs the client's name, the waiver (2 pages) and a before and after photo", async () => {
    expect((await visit(staff, { client: " " })).error).toBe("CLIENT_NAME_REQUIRED");
    expect((await visit(staff, { kinds: ["WAIVER", "BEFORE", "AFTER"] })).error).toBe("WAIVER_PHOTOS_REQUIRED");
    expect((await visit(staff, { kinds: ["WAIVER", "WAIVER", "BEFORE"] })).error).toBe("BEFORE_AFTER_REQUIRED");
    // a check-up needs no photos
    expect((await visit(staff, { kind: "CHECKUP", amount: 0, kinds: [] })).ok).toBe(true);
  });

  it("a different price needs a reason, and a discount earns 5% of what was paid", async () => {
    expect((await visit(staff, { amount: 700000 })).error).toBe("PRICE_NOTE_REQUIRED");
    const r = await visit(staff, { amount: 700000, note: "Promo 22% off" });
    expect(r.ok).toBe(true);
    expect(await lines(r.id)).toEqual([{ role: "SOLO", a: 35000 }]);
  });

  it("refuses photo paths outside this visit's folder or branch", async () => {
    const folder = randomUUID();
    const bad = photos(folder, FULL);
    bad[0].path = `${db.branches.QC_MAIN}/${folder}/waiver-${randomUUID()}.jpg`;
    expect((await visit(staff, { folder, list: bad })).error).toBe("BAD_REQUEST");
    const sneaky = photos(folder, FULL);
    sneaky[1].path = `${db.branches.FAIRVIEW}/${folder}/../x-${randomUUID()}.jpg`;
    expect((await visit(staff, { folder, list: sneaky })).error).toBe("BAD_REQUEST");
    // update-0092: staff aren't locked to their home branch: QC Main staff working at Fairview log it there.
    expect((await db.rpc(qcStaff, "aal1", "log_client_visit", [db.branches.FAIRVIEW, today(), svc, 899900, "SOLO", ana, null, null, "PAID", true,
      "DEMO Client", null, folder, JSON.stringify(photos(folder, FULL)), false])).ok).toBe(true);
  });

  it("client archive: every employee can view it (update-0057)", async () => {
    const month = today();
    // 3: the update-0092 visit QC Main staff logged at Fairview is in the archive too.
    const mine = await db.rpc(staff, "aal1", "client_photo_folders", [month, null, false]);
    expect(mine.length).toBe(3);
    expect(mine[0].photos.length).toBe(4);
    expect((await db.rpc(gm, "aal1", "client_photo_folders", [month, null, false])).length).toBe(3);
    expect((await db.rpc(owner, "aal2", "client_photo_folders", [month, db.branches.FAIRVIEW, false])).length).toBe(3);
    expect((await db.rpc(qcStaff, "aal1", "client_photo_folders", [month, null, false])).length).toBe(3);
    expect((await db.rpc(csr, "aal1", "client_photo_folders", [month, null, false])).length).toBe(3);
  });

  it("social media: only visits the client allowed, never waivers, for every employee", async () => {
    const month = today();
    const s = await db.rpc(csr, "aal1", "client_photo_folders", [month, null, true]);
    expect(s.length).toBe(1);
    expect(s[0].client).toBe("DEMO Client One");
    expect(s[0].photos.map((p: { kind: string }) => p.kind)).toEqual(["BEFORE", "AFTER"]);
    expect((await db.rpc(staff, "aal1", "client_photo_folders", [month, null, true])).length).toBe(1);
  });

  it("owners and the GM can change the sharing choice, even after sign-off; staff can't", async () => {
    expect((await db.rpc(gm, "aal1", "decide_service_log", [shared, true, null])).state).toBe("APPROVED");
    expect((await db.rpc(staff, "aal1", "set_photo_sharing", [shared, false])).ok).toBe(false);
    expect((await db.rpc(gm, "aal1", "set_photo_sharing", [shared, false])).ok).toBe(true);
    expect(await db.rpc(csr, "aal1", "client_photo_folders", [today(), null, true])).toEqual([]);
    // the entry itself stays locked
    await expect(db.sql("SELECT set_config('hermosa.photo_sharing','on',false); UPDATE public.service_logs SET amount_paid_cents = 1 WHERE id = $1", [shared])).rejects.toThrow();
  });

  it("the file rule: every employee opens the visit's files (update-0057)", async () => {
    const p = (await db.sql("SELECT path, kind FROM public.service_photos WHERE service_log_id = $1 ORDER BY kind", [shared])).rows;
    const can = async (who: Person, name: string) =>
      (await db.as(who, "aal1", "SELECT private.can_open_client_photo($1) ok", [name])).rows[0].ok;
    expect(await can(staff, p[0].path)).toBe(true);
    expect(await can(qcStaff, p[0].path)).toBe(true);
    expect(await can(csr, p[0].path)).toBe(true);
    expect(await can(staff, "nope/not-a-photo.jpg")).toBe(false);
  });
});
