// Release 1 security tests: branch isolation, MFA, direct-table attacks, audit integrity.
// Acceptance IDs from build pack docs/04_ACCEPTANCE_CRITERIA.md. All people are DEMO fixtures.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO_CENTS, DEMO_CSV, Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, owner2: Person, finance: Person, fairviewCashier: Person, marikinaManager: Person, outsider: Person;

beforeAll(async () => {
  db = await TestDb.create();
  owner = await db.person("Owner One", [["OWNER", null]]);
  owner2 = await db.person("Owner Two", [["OWNER", null]]);
  finance = await db.person("Finance", [["FINANCE", null]]);
  fairviewCashier = await db.person("Fairview Cashier", [["CASHIER", "FAIRVIEW"]]);
  marikinaManager = await db.person("Marikina Manager", [["MANAGER", "MARIKINA"]]);
  outsider = await db.person("No Grants");
  // Publish one DEMO batch for Marikina so there is something to protect.
  const staged = await db.stage(marikinaManager, "aal1", "MARIKINA", DEMO_CSV, 2, DEMO_CENTS);
  const pub = await db.rpc(owner, "aal2", "publish_historical_batch", [staged.id, 2, DEMO_CENTS]);
  expect(pub.ok).toBe(true);
}, 60_000);

afterAll(async () => db?.close());

describe("AUTH-01 branch isolation", () => {
  it("Fairview cashier asking for Marikina totals is denied, gets no rows, and is audited", async () => {
    const before = await db.auditCount("ACCESS_DENIED");
    const res = await db.rpc(fairviewCashier, "aal1", "historical_sales_totals", [db.branches.MARIKINA, "2025-01-01", "2025-12-31"]);
    expect(res).toEqual({ ok: false, error: "FORBIDDEN" });
    expect(await db.auditCount("ACCESS_DENIED")).toBe(before + 1);
  });

  it("Fairview cashier reading the sales table directly sees no Marikina rows", async () => {
    const { rows } = await db.as(fairviewCashier, "aal1", "SELECT * FROM public.historical_sales");
    expect(rows).toHaveLength(0);
  });

  it("Fairview cashier can read Fairview totals (empty, flagged as no validated data)", async () => {
    const res = await db.rpc(fairviewCashier, "aal1", "historical_sales_totals", [db.branches.FAIRVIEW, "2025-01-01", "2025-12-31"]);
    expect(res.ok).toBe(true);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({ branch_code: "FAIRVIEW", gross_cents: 0, has_validated_data: false });
  });

  it("Marikina manager sees Marikina rows only", async () => {
    const { rows } = await db.as(marikinaManager, "aal1", "SELECT DISTINCT branch_id FROM public.historical_sales");
    expect(rows.map((r) => r.branch_id)).toEqual([db.branches.MARIKINA]);
  });
});

describe("AUTH-02 MFA for privileged roles", () => {
  it("owner without MFA cannot grant roles", async () => {
    const res = await db.rpc(owner, "aal1", "grant_role", [outsider.appUserId, "CASHIER", db.branches.FAIRVIEW]);
    expect(res).toEqual({ ok: false, error: "MFA_REQUIRED" });
  });

  it("owner without MFA cannot see consolidated totals", async () => {
    const res = await db.rpc(owner, "aal1", "historical_sales_totals", [null, "2025-01-01", "2025-12-31"]);
    expect(res.ok).toBe(false);
  });

  it("owner with MFA can grant a role to someone else, and it is audited", async () => {
    const res = await db.rpc(owner, "aal2", "grant_role", [outsider.appUserId, "CASHIER", db.branches.FAIRVIEW]);
    expect(res.ok).toBe(true);
    expect(await db.auditCount("ROLE_GRANTED")).toBeGreaterThanOrEqual(1);
    const revoke = await db.rpc(owner, "aal2", "revoke_role", [res.id]);
    expect(revoke.ok).toBe(true);
  });

  it("no one can raise their own permissions", async () => {
    const res = await db.rpc(owner, "aal2", "grant_role", [owner.appUserId, "FINANCE", null]);
    expect(res).toEqual({ ok: false, error: "SELF_ESCALATION_DENIED" });
  });

  it("a manager cannot grant roles even with MFA", async () => {
    const res = await db.rpc(marikinaManager, "aal2", "grant_role", [outsider.appUserId, "CASHIER", db.branches.MARIKINA]);
    expect(res).toEqual({ ok: false, error: "FORBIDDEN" });
  });
});

describe("AUTH-03 consolidated reporting", () => {
  it("branch manager is denied all-branch totals", async () => {
    const res = await db.rpc(marikinaManager, "aal2", "historical_sales_totals", [null, "2025-01-01", "2025-12-31"]);
    expect(res).toEqual({ ok: false, error: "FORBIDDEN" });
  });

  it("owner consolidated total equals the sum of branch totals and lists all 4 clinics", async () => {
    const res = await db.rpc(owner2, "aal2", "historical_sales_totals", [null, "2025-01-01", "2025-12-31"]);
    expect(res.ok).toBe(true);
    expect(res.rows).toHaveLength(4); // HQ is not a sales branch
    const sum = res.rows.reduce((s: number, r: any) => s + Number(r.gross_cents), 0);
    expect(Number(res.total_gross_cents)).toBe(sum);
    expect(Number(res.total_gross_cents)).toBe(DEMO_CENTS);
    expect(res.basis).toBe("posting_date");
  });
});

describe("SYS-02 direct database attacks", () => {
  it("signed-in users cannot write any table directly", async () => {
    await expect(
      db.as(owner, "aal2", "INSERT INTO public.role_grants (user_id, role_code) VALUES ($1, 'OWNER')", [outsider.appUserId]),
    ).rejects.toThrow(/permission denied/);
    await expect(db.as(owner, "aal2", "UPDATE public.historical_sales SET gross_cents = 1")).rejects.toThrow(/permission denied/);
    await expect(db.as(owner, "aal2", "DELETE FROM public.audit_events")).rejects.toThrow(/permission denied/);
  });

  it("no table grants INSERT, UPDATE or DELETE to anon or authenticated", async () => {
    const { rows } = await db.sql(
      `SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND grantee IN ('anon','authenticated')
         AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE')`,
    );
    expect(rows).toEqual([]);
  });

  it("every public table has row-level security on", async () => {
    const { rows } = await db.sql(
      `SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity`,
    );
    expect(rows).toEqual([]);
  });

  it("a user with no grants sees no sales, batches or audit events", async () => {
    const nobody = await db.person("Nobody");
    for (const t of ["historical_sales", "import_batches", "import_rows", "audit_events", "role_grants", "app_users"]) {
      const { rows } = await db.as(nobody, "aal2", `SELECT 1 FROM public.${t} WHERE ${t === "app_users" ? "id <> $1" : "$1::uuid IS NOT NULL"}`, [nobody.appUserId]);
      expect(rows, t).toHaveLength(0);
    }
  });

  it("an unknown session (no app user) gets nothing and cannot call the API", async () => {
    const { rows } = await db.as(null, "aal1", "SELECT 1 FROM public.branches");
    expect(rows).toHaveLength(0);
    const { rows: r2 } = await db.as(null, "aal1", "SELECT public.historical_sales_totals(NULL, '2025-01-01', '2025-12-31') AS r");
    expect(r2[0].r).toEqual({ ok: false, error: "NOT_AUTHENTICATED" });
  });

  it("anon cannot execute API functions", async () => {
    const client = await (db as any).pool.connect();
    try {
      await client.query("BEGIN; SET LOCAL ROLE anon");
      await expect(client.query("SELECT public.my_access()")).rejects.toThrow(/permission denied/);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

describe("audit integrity", () => {
  it("audit events cannot be changed or deleted, even by the database owner", async () => {
    await expect(db.sql("UPDATE public.audit_events SET action = 'X'")).rejects.toThrow(/AUDIT_APPEND_ONLY/);
    await expect(db.sql("DELETE FROM public.audit_events")).rejects.toThrow(/AUDIT_APPEND_ONLY/);
  });

  it("published historical rows cannot be deleted or edited", async () => {
    await expect(db.sql("DELETE FROM public.historical_sales")).rejects.toThrow(/POSTED_ROWS_ARE_NOT_DELETED/);
    await expect(db.sql("UPDATE public.historical_sales SET gross_cents = gross_cents + 1")).rejects.toThrow(
      /POSTED_ROWS_ARE_IMMUTABLE/,
    );
  });

  it("my_access reports roles and whether MFA is needed", async () => {
    const me = await db.rpc(finance, "aal1", "my_access", []);
    expect(me).toMatchObject({ needs_mfa: true, mfa: false });
    expect(me.grants).toEqual([{ role: "FINANCE", branch_id: null }]);
  });
});
