// Reads the "Sales Source Tracker" Google Sheet download (.xlsx with one tab per branch, or a .csv of one tab)
// and checks it before anything is loaded. Pure functions: runs in the browser and in tests.
// Layout (owner's sheet, Nov 2026): a title row with the branch name, a header row with DATE and Sales,
// one row per day ("Sunday, 1 November 2026" | "₱34,600.00"), then an "ALL TIME Totals" row.
import { unzipSync, strFromU8 } from "fflate";
import { detectBranchCode } from "./quickImport";

export type Cell = string | number | null;
export type Grid = Cell[][];
export type TrackerRow = { date: string; cents: number; line: number };
export type Problem = { line: number; text: string };
export type TrackerSheet = {
  sheet: string;
  branchCode: string | null;
  rows: TrackerRow[];
  problems: Problem[];
  notes: Problem[]; // informational only, e.g. a sheet total that doesn't add up (the days themselves still load)
  blankDays: number;
  fileTotal: number | null;
  sum: number;
  closed: { date: string; line: number }[]; // days typed as CLOSED: shown, never loaded as sales
  isBranchTab: boolean; // has a DATE + Sales header and a known branch
};

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
};

/** Dates as the sheet shows them, or as Excel stores them (day serial numbers). */
export function readDate(v: Cell): string | null {
  if (v === null || v === "") return null;
  if (typeof v === "number") {
    if (v < 20000 || v > 80000) return null; // roughly 1954 to 2119
    return new Date(Math.round((v - 25569) * 86_400_000)).toISOString().slice(0, 10);
  }
  const s = v.trim().toLowerCase().replace(/\s+/g, " ");
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s); // 11/24/26 or 11/24/2026 (month first, as the team writes it)
  if (m) return iso(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[1], +m[2]);
  m = /^(?:[a-z]+,? )?(\d{1,2}) ([a-z]+),? (\d{4})$/.exec(s); // Sunday, 1 November 2026
  if (m && MONTHS.findIndex((x) => x.startsWith(m![2].slice(0, 3))) >= 0) return iso(+m[3], MONTHS.findIndex((x) => x.startsWith(m![2].slice(0, 3))) + 1, +m[1]);
  m = /^(?:[a-z]+,? )?([a-z]+) (\d{1,2}),? (\d{4})$/.exec(s); // Sunday, November 1, 2026
  if (m && MONTHS.findIndex((x) => x.startsWith(m![1].slice(0, 3))) >= 0) return iso(+m[3], MONTHS.findIndex((x) => x.startsWith(m![1].slice(0, 3))) + 1, +m[2]);
  return null;
}

/** "₱34,600.00", "34600", 34600 -> centavos. Blank -> null. Anything else -> NaN. */
export function readMoney(v: Cell): number | null {
  if (v === null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? Math.round(v * 100) : NaN;
  const s = v.trim().replace(/^(php|₱|p)\s*/i, "").replace(/,/g, "").replace(/\s/g, "");
  if (s === "" || s === "-") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
  const [a, b = ""] = s.split(".");
  return Number(a) * 100 + Number((b + "00").slice(0, 2));
}

const norm = (c: Cell) => (typeof c === "string" ? c.trim().toLowerCase().replace(/\s+/g, " ") : "");
const isBlank = (c: Cell) => c === null || c === "";
const CLOSED_WORDS = /^(closed|close|no sales?|nosales|holiday|off)$/;

/** The sales column in a header row: "Sales" first, then "Overall Sales", then any other "...sales" that isn't an ads figure. */
function salesColumn(row: Cell[]): number {
  const n = row.map(norm);
  for (const test of [(x: string) => x === "sales", (x: string) => x === "overall sales", (x: string) => /sales/.test(x) && !/ads|shopify|per/.test(x)]) {
    const i = n.findIndex(test);
    if (i >= 0) return i;
  }
  return -1;
}

/**
 * Read one branch tab. A tab may hold many month blocks, each with its own title row, header row
 * (DATE ... Sales), day rows, then "Daily Averages" and "Totals" rows. Each block's total is checked
 * against its days.
 */
export function readSheet(sheet: string, grid: Grid): TrackerSheet {
  const out: TrackerSheet = { sheet, branchCode: null, rows: [], problems: [], notes: [], blankDays: 0, fileTotal: null, sum: 0, closed: [], isBranchTab: false };
  const titles: string[] = [];
  const seen = new Map<string, number>();
  let dc = -1, sc = -1, blockSum = 0, blockStart = 0, inBlock = false;
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const line = r + 1;
    const d = row.findIndex((c) => norm(c) === "date");
    if (d >= 0 && salesColumn(row) >= 0) {
      [dc, sc, blockSum, blockStart, inBlock] = [d, salesColumn(row), 0, line, true];
      continue;
    }
    if (!inBlock) {
      for (const c of row) if (typeof c === "string" && c.trim()) titles.push(c.trim());
      continue;
    }
    const rawDate = row[dc] ?? null, rawSales = row[sc] ?? null;
    const label = norm(rawDate);
    if (/total/.test(label)) {
      const t = readMoney(rawSales);
      if (t !== null && !Number.isNaN(t)) {
        out.fileTotal = (out.fileTotal ?? 0) + t;
        if (t !== blockSum) {
          out.notes.push({ line, text: `The sheet's total (₱${(t / 100).toLocaleString("en-PH")}) doesn't match its days (₱${(blockSum / 100).toLocaleString("en-PH")}), rows ${blockStart + 1} to ${line - 1}.` });
        }
      }
      inBlock = false; // the next block starts at its own header row
      continue;
    }
    if (/average/.test(label)) continue;
    if (isBlank(rawDate) && isBlank(rawSales)) continue;
    const date = readDate(rawDate);
    if (!date) {
      // A block title like "QC-MAIN" with nothing in the sales column is not a problem.
      if (typeof rawDate === "string" && isBlank(rawSales)) { titles.push(rawDate.trim()); continue; }
      out.problems.push({ line, text: isBlank(rawDate) ? `An amount (${String(rawSales)}) with no date.` : `Can't read the date "${String(rawDate)}".` });
      continue;
    }
    if (seen.has(date)) {
      out.problems.push({ line, text: `${date} is listed twice (rows ${seen.get(date)} and ${line}).` });
      continue;
    }
    seen.set(date, line);
    if (CLOSED_WORDS.test(norm(rawSales))) {
      out.closed.push({ date, line });
      continue;
    }
    const cents = norm(rawSales) === "zero" ? 0 : readMoney(rawSales);
    if (cents === null) {
      out.blankDays++; // a day with no sales typed yet: not loaded, not a problem
      continue;
    }
    if (Number.isNaN(cents)) {
      out.problems.push({ line, text: `${date}: can't read the amount "${String(rawSales)}".` });
      continue;
    }
    out.rows.push({ date, cents, line });
    out.sum += cents;
    blockSum += cents;
  }
  if (dc < 0) out.problems.push({ line: 0, text: "No DATE and Sales columns found in this tab." });
  // Branch: the tab name first, then the block titles (e.g. "MAIN", "QC-FAIRVIEW").
  out.branchCode = detectBranchCode(sheet);
  if (!out.branchCode) {
    const codes = new Set(titles.map((t) => detectBranchCode(t)).filter(Boolean));
    if (codes.size === 1) out.branchCode = [...codes][0]!;
  }
  out.isBranchTab = dc >= 0 && out.branchCode !== null;
  return out;
}

/** Unpack an .xlsx file into tabs of plain cell values (cached formula results included). */
export function readXlsx(bytes: Uint8Array): { name: string; grid: Grid }[] {
  const files = unzipSync(bytes, { filter: (f) => (f.name.startsWith("xl/") && f.name.endsWith(".xml")) || f.name.endsWith(".rels") });
  const text = (p: string) => (files[p] ? strFromU8(files[p]) : "");
  const unxml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, "&");
  const shared = [...text("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map((m) => unxml([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")));
  const rels = new Map([...text("xl/_rels/workbook.xml.rels").matchAll(/<Relationship\b[^>]*>/g)].map((m) => {
    const id = /Id="([^"]+)"/.exec(m[0])?.[1] ?? "", target = /Target="([^"]+)"/.exec(m[0])?.[1] ?? "";
    return [id, target.startsWith("/") ? target.slice(1) : `xl/${target}`];
  }));
  const sheets = [...text("xl/workbook.xml").matchAll(/<sheet\b[^>]*>/g)].map((m) => ({
    name: unxml(/name="([^"]*)"/.exec(m[0])?.[1] ?? ""),
    path: rels.get(/r:id="([^"]+)"/.exec(m[0])?.[1] ?? "") ?? "",
  }));
  const col = (ref: string) => [...(/^[A-Z]+/.exec(ref)?.[0] ?? "A")].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  return sheets.map(({ name, path }) => {
    const grid: Grid = [];
    for (const row of text(path).replace(/<row\b[^>]*\/>/g, "").matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
      const r = Number(/r="(\d+)"/.exec(row[1])?.[1] ?? grid.length + 1) - 1;
      const cells: Cell[] = [];
      for (const c of row[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1], body = c[2] ?? "";
        const ref = /r="([A-Z]+)\d+"/.exec(attrs)?.[1] ?? "A";
        const t = /t="([^"]+)"/.exec(attrs)?.[1];
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        let val: Cell = null;
        if (t === "s" && v !== undefined) val = shared[Number(v)] ?? null;
        else if (t === "inlineStr") val = unxml([...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join(""));
        else if (t === "str" || t === "e") val = v !== undefined ? unxml(v) : null;
        else if (t === "b") val = v ?? null;
        else if (v !== undefined) val = Number.isNaN(Number(v)) ? unxml(v) : Number(v);
        cells[col(ref)] = val;
      }
      grid[r] = Array.from(cells, (x) => x ?? null);
    }
    return { name, grid: Array.from(grid, (x) => x ?? []) };
  });
}

export type Existing = { cents: number | null; mark: string | null; staged: boolean };
export type Check = {
  branchCode: string;
  sheet: string;
  add: TrackerRow[];
  same: TrackerRow[];
  different: (TrackerRow & { osCents: number })[];
  blocked: (TrackerRow & { why: string })[];
};

/** Compare a tab with what the OS already has. Only "add" rows load; "different" rows need a decision. */
export function compareWithOs(s: TrackerSheet, existing: Map<string, Existing>, today: string): Check {
  const out: Check = { branchCode: s.branchCode ?? "", sheet: s.sheet, add: [], same: [], different: [], blocked: [] };
  for (const r of s.rows) {
    const e = existing.get(r.date);
    if (r.date > today) out.blocked.push({ ...r, why: "future date" });
    else if (e?.staged) out.blocked.push({ ...r, why: "already uploaded and waiting for sign-off" });
    else if (e?.mark && r.cents > 0) out.blocked.push({ ...r, why: `marked ${e.mark === "CLOSED" ? "Closed" : "No sales"} in the OS` });
    else if (e?.mark) out.same.push(r);
    else if (e?.cents == null) {
      if (r.cents === 0) out.blocked.push({ ...r, why: "₱0: mark it Closed or No sales on Missing days instead" });
      else out.add.push(r);
    } else if (e.cents === r.cents) out.same.push(r);
    else out.different.push({ ...r, osCents: e.cents });
  }
  return out;
}
