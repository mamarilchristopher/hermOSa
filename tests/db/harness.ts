// TEST ONLY: builds a throwaway database from the real migrations and runs queries as
// Supabase's `authenticated` role with JWT claims (sub + aal), the way RLS sees a real session.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { parseHistoricalSalesCsv } from "../../src/lib/csv";

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres@localhost:54329/postgres?host=/var/run/postgresql";
const root = join(__dirname, "..", "..");

export type Aal = "aal1" | "aal2";
export type Person = { appUserId: string; authSubject: string; name: string; sessionId?: string };

export class TestDb {
  branches: Record<string, string> = {};

  private constructor(
    public readonly name: string,
    private pool: pg.Pool,
    private admin: pg.Client,
  ) {}

  static async create(): Promise<TestDb> {
    const name = `hermosa_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(ADMIN_URL);
    url.pathname = `/${name}`;
    const pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
    const db = new TestDb(name, pool, admin);
    await db.sql(readFileSync(join(root, "tests/db/supabase-shim.sql"), "utf8"));
    const migDir = join(root, "supabase/migrations");
    for (const f of readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort()) {
      await db.sql(readFileSync(join(migDir, f), "utf8"));
    }
    await db.sql(readFileSync(join(root, "supabase/seed.sql"), "utf8"));
    const { rows } = await pool.query("SELECT code, id FROM public.branches");
    for (const r of rows) db.branches[r.code] = r.id;
    return db;
  }

  async close() {
    await this.pool.end();
    await this.admin.query(`DROP DATABASE IF EXISTS ${this.name} WITH (FORCE)`);
    await this.admin.end();
  }

  /** Superuser query: setup and assertions only. */
  async sql<T extends pg.QueryResultRow = any>(text: string, params: unknown[] = []) {
    return this.pool.query<T>(text, params);
  }

  /** DEMO user with optional grants: [role, branchCode | null]. */
  async person(name: string, grants: Array<[string, string | null]> = []): Promise<Person> {
    const authSubject = randomUUID();
    const { rows } = await this.sql(
      `INSERT INTO public.app_users (organization_id, auth_subject, display_name, email)
       VALUES ('00000000-0000-4000-8000-000000000001', $1, $2, $3) RETURNING id`,
      [authSubject, `DEMO ${name}`, `${name.toLowerCase().replace(/\W+/g, ".")}@demo.invalid`],
    );
    for (const [role, code] of grants) {
      await this.sql(`INSERT INTO public.role_grants (user_id, role_code, branch_id) VALUES ($1, $2, $3)`, [
        rows[0].id,
        role,
        code ? this.branches[code] : null,
      ]);
    }
    return { appUserId: rows[0].id, authSubject, name };
  }

  /** Run one statement as a signed-in user (role `authenticated`, RLS on). */
  async as<T extends pg.QueryResultRow = any>(who: Person | null, aal: Aal, text: string, params: unknown[] = []) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE authenticated");
      const claims = who ? { sub: who.authSubject, role: "authenticated", aal, session_id: who.sessionId ?? who.authSubject } : { role: "authenticated" };
      await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
      const res = await client.query<T>(text, params);
      await client.query("COMMIT");
      return res;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async rpc(who: Person, aal: Aal, fn: string, args: unknown[]): Promise<any> {
    const placeholders = args.map((_, i) => `$${i + 1}`).join(", ");
    const { rows } = await this.as(who, aal, `SELECT public.${fn}(${placeholders}) AS r`, args);
    return rows[0].r;
  }

  async stage(
    who: Person,
    aal: Aal,
    branchCode: string,
    csv: string,
    expectedRows: number,
    expectedCents: number,
    filename = "demo.csv",
  ) {
    const rows = parseHistoricalSalesCsv(csv);
    return this.rpc(who, aal, "stage_historical_sales", [
      this.branches[branchCode],
      filename,
      csv,
      JSON.stringify(rows),
      expectedRows,
      expectedCents,
    ]);
  }

  async auditCount(action: string, where = "true") {
    const { rows } = await this.sql(
      `SELECT count(*)::int AS n FROM public.audit_events WHERE action = $1 AND ${where}`,
      [action],
    );
    return rows[0].n as number;
  }
}

export const DEMO_CSV =
  "source_id,posting_date,amount_php\nDEMO-0001,2025-11-02,1250.00\nDEMO-0002,2025-11-03,750.50\n";
export const DEMO_CENTS = 200050;
