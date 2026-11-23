import { describe, expect, it } from "vitest";
import { parseHistoricalSalesCsv } from "../../src/lib/csv";
import { detectBranchCode, keepLoadableRows } from "../../src/lib/quickImport";

describe("detectBranchCode", () => {
  it.each([
    ["QC-Main_2023-01_to_2023-12.csv", "QC_MAIN"],
    ["Fairview_2024-07_to_2026-11.csv", "FAIRVIEW"],
    ["Marikina_2024-07_to_2026-11.csv", "MARIKINA"],
    ["Sta-Maria_2023-04_to_2023-12.csv", "STA_MARIA"],
    ["sta maria bulacan.csv", "STA_MARIA"],
    ["Mindanao 2023.csv", "QC_MAIN"],
  ])("%s -> %s", (name, code) => expect(detectBranchCode(name)).toBe(code));

  it("falls back to DAILY-<BRANCH> source ids, and gives up when unsure", () => {
    const rows = parseHistoricalSalesCsv("source_id,posting_date,amount_php\nDAILY-MARIKINA-2025-01-01,2025-01-01,100.00\n");
    expect(detectBranchCode("export.csv", rows)).toBe("MARIKINA");
    expect(detectBranchCode("export.csv")).toBeNull();
    expect(detectBranchCode("fairview vs marikina.csv")).toBeNull();
  });
});

describe("keepLoadableRows", () => {
  it("skips unreadable and repeated rows, renumbers, and totals the rest", () => {
    const rows = parseHistoricalSalesCsv(
      "source_id,posting_date,amount_php\nA,2025-01-01,100.50\nB,2025-13-01,5\nC,2025-01-02,abc\nA,2025-01-03,7\nD,2025-01-04,1000\n,2025-01-05,1\n",
    );
    const out = keepLoadableRows(rows);
    expect(out.rows.map((r) => [r.row_number, r.source_key])).toEqual([[1, "A"], [2, "D"]]);
    expect(out.cents).toBe(110050);
    expect(out.skipped).toBe(4);
  });
});
