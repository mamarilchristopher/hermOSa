// CSV parsing and money helpers for historical imports.
// Ported from build pack v1.0 reference_slice/history.mjs (csvRows, phpToCents).
// The database re-validates every field; this parse only shapes the upload.

export class CsvError extends Error {}

/** RFC 4180-style CSV: quoted fields, embedded commas, escaped double quotes, CRLF or LF. */
export function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let atCellStart = true;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (quoted) {
        quoted = false;
      } else if (atCellStart) {
        quoted = true;
        atCellStart = false;
      } else {
        throw new CsvError("MALFORMED_CSV");
      }
    } else if (ch === "," && !quoted) {
      row.push(cell);
      cell = "";
      atCellStart = true;
    } else if ((ch === "\n" || ch === "\r") && !quoted) {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
      cell = "";
      atCellStart = true;
    } else {
      cell += ch;
      atCellStart = false;
    }
  }
  if (quoted) throw new CsvError("UNCLOSED_CSV_QUOTE");
  row.push(cell);
  if (row.some((x) => x !== "")) rows.push(row);
  return rows;
}

/** "1,250.50" is rejected on purpose: thousands separators must be removed in the source. */
export function phpToCents(value: string): number {
  const txt = String(value).trim().replace(/^₱/, "");
  if (!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(txt)) throw new CsvError("INVALID_MONEY");
  const [pesos, dec = ""] = txt.split(".");
  const result = BigInt(pesos) * 100n + BigInt((dec + "00").slice(0, 2));
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new CsvError("AMOUNT_TOO_LARGE");
  return Number(result);
}

export function centsToPhp(cents: number | bigint): string {
  const c = BigInt(cents);
  const sign = c < 0n ? "-" : "";
  const abs = c < 0n ? -c : c;
  const pesos = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}₱${pesos}.${(abs % 100n).toString().padStart(2, "0")}`;
}

export const HISTORICAL_SALES_COLUMNS = ["source_id", "posting_date", "amount_php"] as const;

export type StagedRow = {
  row_number: number;
  source_key: string;
  posting_date: string;
  amount: string;
  raw: string[];
  column_count_ok: boolean;
};

/** Shape a historical sales CSV into rows for public.stage_historical_sales. */
export function parseHistoricalSalesCsv(text: string): StagedRow[] {
  const rows = csvRows(text.replace(/^﻿/, ""));
  if (rows.length < 2) throw new CsvError("CSV_HAS_NO_RECORDS");
  const keys = rows[0].map((x) => x.trim().toLowerCase());
  if (new Set(keys).size !== keys.length || !HISTORICAL_SALES_COLUMNS.every((c) => keys.includes(c))) {
    throw new CsvError("MISSING_CSV_COLUMNS");
  }
  const ix = Object.fromEntries(keys.map((k, i) => [k, i])) as Record<string, number>;
  return rows.slice(1).map((row, i) => ({
    row_number: i + 1,
    source_key: (row[ix.source_id] ?? "").trim(),
    posting_date: (row[ix.posting_date] ?? "").trim(),
    amount: (row[ix.amount_php] ?? "").trim(),
    raw: row,
    column_count_ok: row.length === keys.length,
  }));
}
