// update-0082: Documents, approved forms with every version. DEMO data only.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, gm: Person, cma: Person;
const path = (k: string) => `${k}/11111111-2222-4333-8444-${String(Date.now()).slice(-12).padStart(12, "0")}.pdf`;

beforeAll(async () => {
  db = await TestDb.create();
  owner = await db.person("Owner", [["OWNER", null]]);
  gm = await db.person("General Manager", [["MANAGER", null]]);
  cma = await db.person("Fairview CMA", [["CLINICIAN", "FAIRVIEW"]]);
  // The built-in forms are loaded per organization; the test organization is made after the migrations ran.
  const sql = readFileSync("supabase/migrations/20261126000082_documents.sql", "utf8");
  await db.sql(sql.slice(sql.indexOf("-- The forms approved so far")));
}, 60_000);
afterAll(async () => db?.close());

describe("documents", () => {
  it("built-in forms are loaded and everyone can read them", async () => {
    const rows = (await db.as(cma, "aal1", "SELECT doc_key, version FROM public.documents ORDER BY doc_key, created_at")).rows;
    expect(rows.filter((r) => r.doc_key === "declaration-consent").map((r) => r.version)).toEqual(["Original", "Version 2", "Version 3"]);
    expect(new Set(rows.map((r) => r.doc_key)).size).toBe(6);
  });
  it("only owners and the GM add versions; a new key starts a new document", async () => {
    const p = path("declaration-consent");
    expect(await db.rpc(cma, "aal1", "add_document_version", ["declaration-consent", null, null, "Version 4", null, p, "x.pdf", null])).toMatchObject({ ok: false, error: "FORBIDDEN" });
    expect(await db.rpc(gm, "aal1", "add_document_version", ["declaration-consent", "Ignored title", "Other", "Version 4", "DEMO", p, "x.pdf", "2026-11-27"])).toMatchObject({ ok: true });
    const r = (await db.sql("SELECT title, category FROM public.documents WHERE file_path = $1", [p])).rows[0];
    expect(r).toEqual({ title: "Declaration and Consent Form", category: "Client forms" });
    const q = path("staff-contract");
    expect(await db.rpc(owner, "aal2", "add_document_version", ["staff-contract", "Staff Contract", "Staff forms", "Version 1", null, q, "c.pdf", null])).toMatchObject({ ok: true });
    expect(await db.rpc(owner, "aal2", "add_document_version", ["staff-contract", "Staff Contract", null, "V2", null, "other/abc.pdf", "c.pdf", null])).toMatchObject({ ok: false, error: "BAD_REQUEST" });
  });
  it("removed versions disappear for everyone", async () => {
    const id = (await db.sql("SELECT id FROM public.documents WHERE doc_key = 'staff-contract'")).rows[0].id;
    expect(await db.rpc(cma, "aal1", "remove_document_version", [id])).toMatchObject({ ok: false, error: "FORBIDDEN" });
    expect(await db.rpc(gm, "aal1", "remove_document_version", [id])).toMatchObject({ ok: true });
    expect((await db.as(cma, "aal1", "SELECT count(*)::int n FROM public.documents WHERE doc_key = 'staff-contract'")).rows[0].n).toBe(0);
    expect(await db.rpc(gm, "aal1", "remove_document_version", [id])).toMatchObject({ ok: false, error: "NOT_FOUND" });
  });
});
