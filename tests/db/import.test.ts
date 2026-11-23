// Historical sales importer: staging, validation, reconciliation, four-eyes publish, reversal.
// Ports the 13 behaviours of build pack reference_slice/history.test.mjs to PostgreSQL.
// Acceptance IDs: DATA-01..DATA-05. All data are DEMO fixtures.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO_CENTS, DEMO_CSV, Person, TestDb } from "./harness";

let db: TestDb;
let owner: Person, finance: Person, qcManager: Person, fairviewManager: Person, cashier: Person;

beforeAll(async () => {
  db = await TestDb.create();
  owner = await db.person("Owner", [["OWNER", null]]);
  finance = await db.person("Finance", [["FINANCE", null]]);
  qcManager = await db.person("QC Manager", [["MANAGER", "QC_MAIN"]]);
  fairviewManager = await db.person("Fairview Manager", [["MANAGER", "FAIRVIEW"]]);
  cashier = await db.person("QC Cashier", [["CASHIER", "QC_MAIN"]]);
}, 60_000);

afterAll(async () => db?.close());

const range = ["2025-01-01", "2025-12-31"];
const qcTotal = async () => {
  const r = await db.rpc(owner, "aal2", "historical_sales_totals", [db.branches.QC_MAIN, ...range]);
  return Number(r.rows[0].gross_cents);
};

describe("staging and validation", () => {
  it("DATA-05: with no history the report says no validated data instead of showing zero as fact", async () => {
    const r = await db.rpc(owner, "aal2", "historical_sales_totals", [null, ...range]);
    expect(r.any_validated_data).toBe(false);
    expect(r.rows.every((x: any) => x.has_validated_data === false)).toBe(true);
  });

  it("cashiers cannot stage imports; managers only for their own branch", async () => {
    expect(await db.stage(cashier, "aal1", "QC_MAIN", DEMO_CSV, 2, DEMO_CENTS)).toEqual({ ok: false, error: "FORBIDDEN" });
    expect(await db.stage(qcManager, "aal1", "FAIRVIEW", DEMO_CSV, 2, DEMO_CENTS)).toEqual({ ok: false, error: "FORBIDDEN" });
  });

  it("staged rows never appear in reports; after sign-off they do", async () => {
    const s = await db.stage(qcManager, "aal1", "QC_MAIN", DEMO_CSV, 2, DEMO_CENTS, "qc-nov.csv");
    expect(s).toMatchObject({ ok: true, state: "STAGED", duplicate: false });
    expect(await qcTotal()).toBe(0);
    const p = await db.rpc(finance, "aal2", "publish_historical_batch", [s.id, 2, DEMO_CENTS]);
    expect(p).toMatchObject({ ok: true, state: "PUBLISHED", rows: 2 });
    expect(Number(p.gross_cents)).toBe(DEMO_CENTS);
    expect(await qcTotal()).toBe(DEMO_CENTS);
    const { rows } = await db.sql("SELECT * FROM public.import_signoffs WHERE batch_id = $1", [s.id]);
    expect(rows[0].reviewer_id).toBe(finance.appUserId);
    expect(rows[0].source_sha256).toHaveLength(64);
  });

  it("DATA-02: the same file staged twice returns the existing batch, no duplicate rows", async () => {
    const again = await db.stage(qcManager, "aal1", "QC_MAIN", DEMO_CSV, 2, DEMO_CENTS, "renamed.csv");
    expect(again).toMatchObject({ ok: true, duplicate: true, state: "PUBLISHED" });
    const { rows } = await db.sql("SELECT count(*)::int AS n FROM public.historical_sales WHERE branch_id = $1", [db.branches.QC_MAIN]);
    expect(rows[0].n).toBe(2);
  });

  it("DATA-01: invalid dates and amounts are kept with reasons and block publishing", async () => {
    const csv = "source_id,posting_date,amount_php\nDEMO-B1,2025-02-30,100.00\nDEMO-B2,2025-02-01,1,000\nDEMO-B3,2025-02-02,50.00\n,2025-02-03,10.00\n";
    const s = await db.stage(fairviewManager, "aal1", "FAIRVIEW", csv, 4, 16000);
    expect(s.ok).toBe(true);
    const { rows } = await db.sql(
      "SELECT row_number, state, validation_errors FROM public.import_rows WHERE batch_id = $1 ORDER BY row_number",
      [s.id],
    );
    expect(rows[0].validation_errors).toEqual(["INVALID_DATE"]);
    expect(rows[1].validation_errors).toEqual(["WRONG_COLUMN_COUNT"]); // "1,000" splits into two cells
    expect(rows[2].state).toBe("VALID");
    expect(rows[3].validation_errors).toEqual(["MISSING_SOURCE_ID"]);
    const p = await db.rpc(owner, "aal2", "publish_historical_batch", [s.id, 4, 16000]);
    expect(p).toMatchObject({ ok: false, error: "INVALID_ROWS", invalid_rows: 3 });
    const { rows: pub } = await db.sql("SELECT count(*)::int AS n FROM public.historical_sales WHERE batch_id = $1", [s.id]);
    expect(pub[0].n).toBe(0);
  });

  it("a source id repeated inside one file is rejected", async () => {
    const csv = "source_id,posting_date,amount_php\nDEMO-D1,2025-03-01,10.00\nDEMO-D1,2025-03-02,20.00\n";
    const s = await db.stage(fairviewManager, "aal1", "FAIRVIEW", csv, 2, 3000);
    const { rows } = await db.sql("SELECT validation_errors FROM public.import_rows WHERE batch_id = $1 ORDER BY row_number", [s.id]);
    expect(rows[1].validation_errors).toEqual(["DUPLICATE_SOURCE_IN_BATCH"]);
  });
});

describe("reconciliation and four-eyes sign-off", () => {
  it("DATA-03: totals that disagree with the branch's source totals cannot publish", async () => {
    const csv = "source_id,posting_date,amount_php\nDEMO-R1,2025-04-01,500.00\n";
    const s = await db.stage(fairviewManager, "aal1", "FAIRVIEW", csv, 1, 49999);
    const p = await db.rpc(owner, "aal2", "publish_historical_batch", [s.id, 1, 49999]);
    expect(p).toMatchObject({ ok: false, error: "RECONCILIATION_FAILED", actual_rows: 1 });
  });

  it("the reviewer's re-entered totals must match too", async () => {
    const csv = "source_id,posting_date,amount_php\nDEMO-R2,2025-04-02,500.00\n";
    const s = await db.stage(fairviewManager, "aal1", "FAIRVIEW", csv, 1, 50000);
    const p = await db.rpc(owner, "aal2", "publish_historical_batch", [s.id, 1, 50001]);
    expect(p.error).toBe("RECONCILIATION_FAILED");
  });

  it("the uploader cannot sign off their own batch", async () => {
    const csv = "source_id,posting_date,amount_php\nDEMO-S1,2025-05-01,10.00\n";
    const s = await db.stage(finance, "aal2", "MARIKINA", csv, 1, 1000);
    const p = await db.rpc(finance, "aal2", "publish_historical_batch", [s.id, 1, 1000]);
    expect(p).toEqual({ ok: false, error: "SELF_APPROVAL_DENIED" });
    expect(await db.auditCount("ACCESS_DENIED", "next_value->>'error' = 'SELF_APPROVAL_DENIED'")).toBe(1);
  });

  it("managers and non-MFA owners cannot publish", async () => {
    const csv = "source_id,posting_date,amount_php\nDEMO-M1,2025-05-02,10.00\n";
    const s = await db.stage(qcManager, "aal1", "QC_MAIN", csv, 1, 1000);
    expect((await db.rpc(qcManager, "aal2", "publish_historical_batch", [s.id, 1, 1000])).error).toBe("FORBIDDEN");
    expect((await db.rpc(owner, "aal1", "publish_historical_batch", [s.id, 1, 1000])).error).toBe("MFA_REQUIRED");
  });

  it("a locked import period blocks publishing into it", async () => {
    await db.sql(
      "INSERT INTO public.period_locks (branch_id, domain, start_on, end_on, locked_by) VALUES ($1, 'IMPORT', '2024-01-01', '2024-12-31', $2)",
      [db.branches.STA_MARIA, owner.appUserId],
    );
    const csv = "source_id,posting_date,amount_php\nDEMO-L1,2024-06-01,10.00\n";
    const s = await db.stage(finance, "aal2", "STA_MARIA", csv, 1, 1000);
    expect((await db.rpc(owner, "aal2", "publish_historical_batch", [s.id, 1, 1000])).error).toBe("PERIOD_LOCKED");
  });
});

describe("reversal and re-import", () => {
  it("a source id already published cannot publish again from a different file", async () => {
    const csv = "source_id,posting_date,amount_php\nDEMO-0001,2025-11-02,1250.00\n";
    const s = await db.stage(qcManager, "aal1", "QC_MAIN", csv, 1, 125000, "edited.csv");
    const { rows } = await db.sql("SELECT validation_errors FROM public.import_rows WHERE batch_id = $1", [s.id]);
    expect(rows[0].validation_errors).toEqual(["EXISTING_SOURCE_ID"]);
    expect((await db.rpc(owner, "aal2", "publish_historical_batch", [s.id, 1, 125000])).error).toBe("INVALID_ROWS");
  });

  it("DATA-04: reversal removes totals but keeps rows, sign-off and audit", async () => {
    const { rows: b } = await db.sql(
      "SELECT id FROM public.import_batches WHERE branch_id = $1 AND state = 'PUBLISHED'",
      [db.branches.QC_MAIN],
    );
    const batchId = b[0].id;
    expect((await db.rpc(owner, "aal2", "reverse_historical_batch", [batchId, "short"])).error).toBe("REASON_REQUIRED");
    expect((await db.rpc(qcManager, "aal2", "reverse_historical_batch", [batchId, "Wrong month exported"])).error).toBe("FORBIDDEN");
    const r = await db.rpc(owner, "aal2", "reverse_historical_batch", [batchId, "Wrong month exported"]);
    expect(r).toMatchObject({ ok: true, state: "REVERSED" });
    expect(await qcTotal()).toBe(0);
    const { rows: kept } = await db.sql("SELECT count(*)::int AS n FROM public.historical_sales WHERE batch_id = $1", [batchId]);
    expect(kept[0].n).toBe(2);
    expect(await db.auditCount("IMPORT_REVERSED")).toBe(1);
    expect(await db.auditCount("IMPORT_PUBLISHED")).toBeGreaterThanOrEqual(1);
  });

  it("a reversed file can be staged and published again without double counting", async () => {
    const s = await db.stage(qcManager, "aal1", "QC_MAIN", DEMO_CSV, 2, DEMO_CENTS, "qc-nov-fixed.csv");
    expect(s).toMatchObject({ ok: true, duplicate: false });
    const p = await db.rpc(owner, "aal2", "publish_historical_batch", [s.id, 2, DEMO_CENTS]);
    expect(p.ok).toBe(true);
    expect(await qcTotal()).toBe(DEMO_CENTS);
  });

  it("owner consolidated total has no double counting across branches and reversals", async () => {
    const r = await db.rpc(owner, "aal2", "historical_sales_totals", [null, ...range]);
    const { rows } = await db.sql("SELECT coalesce(sum(gross_cents),0)::bigint AS c FROM public.historical_sales WHERE reversed_at IS NULL");
    expect(Number(r.total_gross_cents)).toBe(Number(rows[0].c));
    expect(r.rows.find((x: any) => x.branch_code === "QC_MAIN").has_validated_data).toBe(true);
  });
});

describe("discarding a staged batch", () => {
  it("a batch with wrong expected totals can be discarded and the same file staged again", async () => {
    const csv = "source_id,posting_date,amount_php\nDEMO-X1,2025-06-01,10.00\nDEMO-X2,2025-06-02,5.50\n";
    const wrong = await db.stage(fairviewManager, "aal1", "FAIRVIEW", csv, 2, 1600);
    expect((await db.stage(fairviewManager, "aal1", "FAIRVIEW", csv, 2, 1550)).duplicate).toBe(true);
    expect((await db.rpc(cashier, "aal1", "cancel_staged_batch", [wrong.id, "Typed the total wrong"])).error).toBe("FORBIDDEN");
    expect((await db.rpc(fairviewManager, "aal1", "cancel_staged_batch", [wrong.id, "short"])).error).toBe("REASON_REQUIRED");
    expect((await db.rpc(fairviewManager, "aal1", "cancel_staged_batch", [wrong.id, "Typed the total wrong"])).ok).toBe(true);
    const fixed = await db.stage(fairviewManager, "aal1", "FAIRVIEW", csv, 2, 1550);
    expect(fixed).toMatchObject({ ok: true, duplicate: false });
    expect((await db.rpc(owner, "aal2", "publish_historical_batch", [fixed.id, 2, 1550])).ok).toBe(true);
    expect(await db.auditCount("IMPORT_DISCARDED")).toBe(1);
  });

  it("published batches cannot be discarded, only reversed", async () => {
    const { rows } = await db.sql("SELECT id FROM public.import_batches WHERE state = 'PUBLISHED' LIMIT 1");
    expect((await db.rpc(owner, "aal2", "cancel_staged_batch", [rows[0].id, "Should not work"])).error).toBe("NOT_STAGED");
  });
});
