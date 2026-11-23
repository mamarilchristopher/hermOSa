// Pre-launch quick import: many files at once, no typed totals.
// The branch comes from the file name (e.g. "QC-Main_2023-01_to_2023-12.csv") or, failing that,
// from source ids like "DAILY-QC_MAIN-2023-01-01". Rows that can't be read are skipped, not fatal.
import { isIsoDate } from "./dates";
import { phpToCents, type StagedRow } from "./csv";

const BRANCH_HINTS: [string, string[]][] = [
  ["QC_MAIN", ["qcmain", "main", "mindanao", "sikatuna", "quezoncity"]],
  ["FAIRVIEW", ["fairview"]],
  ["MARIKINA", ["marikina"]],
  ["STA_MARIA", ["stamaria", "santamaria", "smb", "bulacan"]],
];

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export function detectBranchCode(filename: string, rows: StagedRow[] = []): string | null {
  const name = squash(filename.replace(/\.csv$/i, ""));
  const byName = BRANCH_HINTS.filter(([, hints]) => hints.some((h) => name.includes(h))).map(([code]) => code);
  if (byName.length === 1) return byName[0];
  // "fairview main" style names are ambiguous: prefer a specific branch over the generic "main".
  const specific = byName.filter((c) => c !== "QC_MAIN");
  if (specific.length === 1) return specific[0];
  const fromIds = new Set(rows.map((r) => /^DAILY-([A-Z_]+)-\d{4}-\d{2}-\d{2}$/.exec(r.source_key)?.[1]).filter(Boolean));
  if (fromIds.size === 1) {
    const code = [...fromIds][0]!;
    if (BRANCH_HINTS.some(([c]) => c === code)) return code;
  }
  return null;
}

/** Keep only rows that will load; renumber them. Returns the kept rows, their total and how many were skipped. */
export function keepLoadableRows(rows: StagedRow[]): { rows: StagedRow[]; cents: number; skipped: number } {
  const seen = new Set<string>();
  const kept: StagedRow[] = [];
  let cents = 0;
  for (const r of rows) {
    let c: number;
    try {
      c = phpToCents(r.amount.replace(/,/g, ""));
    } catch {
      continue;
    }
    if (!r.column_count_ok || !r.source_key || seen.has(r.source_key) || !isIsoDate(r.posting_date)) continue;
    seen.add(r.source_key);
    cents += c;
    kept.push({ ...r, amount: r.amount.replace(/,/g, ""), row_number: kept.length + 1 });
  }
  return { rows: kept, cents, skipped: rows.length - kept.length };
}
