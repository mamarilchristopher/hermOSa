import { describe, expect, it } from "vitest";
import { centsToPhp, csvRows, parseHistoricalSalesCsv, phpToCents } from "../../src/lib/csv";

describe("csv helpers", () => {
  it("parses money exactly as integer centavos", () => {
    expect(phpToCents("1250.00")).toBe(125000);
    expect(phpToCents("₱750.5")).toBe(75050);
    expect(phpToCents("0.01")).toBe(1);
    expect(() => phpToCents("1,250.00")).toThrow("INVALID_MONEY");
    expect(() => phpToCents("-5")).toThrow("INVALID_MONEY");
    expect(() => phpToCents("1.005")).toThrow("INVALID_MONEY");
  });

  it("formats centavos as pesos", () => {
    expect(centsToPhp(125000)).toBe("₱1,250.00");
    expect(centsToPhp(5)).toBe("₱0.05");
    expect(centsToPhp(123456789)).toBe("₱1,234,567.89");
  });

  it("handles quoted fields, embedded commas and CRLF", () => {
    expect(csvRows('a,b\r\n"x, y","he said ""hi"""\r\n')).toEqual([
      ["a", "b"],
      ["x, y", 'he said "hi"'],
    ]);
    expect(() => csvRows('a,"b')).toThrow("UNCLOSED_CSV_QUOTE");
    expect(() => csvRows('a,b"c')).toThrow("MALFORMED_CSV");
  });

  it("shapes historical sales rows and flags wrong column counts", () => {
    const rows = parseHistoricalSalesCsv("﻿source_id,posting_date,amount_php\nDEMO-1,2025-11-02,1250.00\nDEMO-2,2025-11-03\n");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ row_number: 1, source_key: "DEMO-1", amount: "1250.00", column_count_ok: true });
    expect(rows[1].column_count_ok).toBe(false);
  });

  it("rejects files without the required columns or records", () => {
    expect(() => parseHistoricalSalesCsv("id,date,amount\n1,2025-01-01,5")).toThrow("MISSING_CSV_COLUMNS");
    expect(() => parseHistoricalSalesCsv("source_id,posting_date,amount_php\n")).toThrow("CSV_HAS_NO_RECORDS");
  });
});
