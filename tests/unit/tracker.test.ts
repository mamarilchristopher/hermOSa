import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { compareWithOs, readDate, readMoney, readSheet, readXlsx, type Existing } from "../../src/lib/tracker";

describe("tracker cells", () => {
  it("reads the sheet's date styles and Excel day numbers", () => {
    expect(readDate("Sunday, 1 November 2026")).toBe("2026-11-01");
    expect(readDate("Wednesday, 11 November 202")).toBeNull(); // cut-off text in a narrow column: flagged, never guessed
    expect(readDate("11/24/26")).toBe("2026-11-24");
    expect(readDate(45483)).toBe("2024-07-10");
    expect(readDate("31/02/2026")).toBeNull();
  });
  it("reads peso amounts", () => {
    expect(readMoney("₱34,600.00")).toBe(3460000);
    expect(readMoney(55749)).toBe(5574900);
    expect(readMoney("")).toBeNull();
    expect(readMoney("abc")).toBeNaN();
  });
});

const grid = [
  ["MAIN"],
  ["DATE", "Sales", "Message Results"],
  ["Sunday, 1 November 2026", "₱34,600.00"],
  ["Monday, 2 November 2026", "₱9,000.00"],
  ["Tuesday, 3 November 2026", "CLOSED"],
  ["Wednesday, 4 November 2026", null],
  ["Monday, 2 November 2026", "₱1.00"],
  ["ALL TIME Daily Averages:", null],
  ["ALL TIME Totals:", "₱43,600.00"],
  [],
  ["QC-MAIN"],
  ["DATE", "Amount Spent", "Overall Sales"],
  ["Tuesday, 1 December 2026", 0, 1000],
  ["ALL TIME Totals:", 0, 999],
];

describe("readSheet", () => {
  const s = readSheet("Sheet1", grid);
  it("finds the branch from the title, reads every month block", () => {
    expect(s.branchCode).toBe("QC_MAIN");
    expect(s.isBranchTab).toBe(true);
    expect(s.rows.map((r) => [r.date, r.cents])).toEqual([["2026-11-01", 3460000], ["2026-11-02", 900000], ["2026-12-01", 100000]]);
    expect(s.closed.map((c) => c.date)).toEqual(["2026-11-03"]);
    expect(s.blankDays).toBe(1);
  });
  it("flags repeated days; a sheet total that doesn't add up is only a note", () => {
    expect(s.problems.map((p) => p.text)).toEqual(["2026-11-02 is listed twice (rows 4 and 7)."]);
    expect(s.notes.map((p) => p.text)).toEqual(["The sheet's total (₱999) doesn't match its days (₱1,000), rows 13 to 13."]);
  });
});

describe("compareWithOs", () => {
  it("adds new days, skips matching ones, and holds back differences", () => {
    const s = readSheet("MAIN", grid);
    const existing = new Map<string, Existing>([
      ["2026-11-01", { cents: 3460000, mark: null, staged: false }],
      ["2026-11-02", { cents: 800000, mark: null, staged: false }],
    ]);
    const c = compareWithOs(s, existing, "2026-11-30");
    expect(c.same.map((r) => r.date)).toEqual(["2026-11-01"]);
    expect(c.different).toEqual([{ date: "2026-11-02", cents: 900000, line: 4, osCents: 800000 }]);
    expect(c.add).toEqual([]);
    expect(c.blocked.map((r) => r.why)).toEqual(["future date"]);
  });
});

describe("readXlsx", () => {
  it("reads tabs, shared strings and numbers from an .xlsx file", () => {
    const xml = (s: string) => strToU8(`<?xml version="1.0"?>${s}`);
    const bytes = zipSync({
      "xl/workbook.xml": xml(`<workbook><sheets><sheet name="Fairview" sheetId="1" r:id="rId1"/></sheets></workbook>`),
      "xl/_rels/workbook.xml.rels": xml(`<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`),
      "xl/sharedStrings.xml": xml(`<sst><si><t>DATE</t></si><si><t>Sales</t></si><si><r><t>₱1,</t></r><r><t>000.00</t></r></si></sst>`),
      "xl/worksheets/sheet1.xml": xml(`<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>` +
        `<row r="2"/><row r="3"><c r="A3"><v>46350</v></c><c r="B3" t="s"><v>2</v></c></row>` +
        `<row r="4"><c r="A4" t="inlineStr"><is><t>ALL TIME Totals:</t></is></c><c r="B4"><f>SUM(B3)</f><v>1000</v></c></row></sheetData></worksheet>`),
    });
    const [tab] = readXlsx(bytes);
    expect(tab.name).toBe("Fairview");
    const s = readSheet(tab.name, tab.grid);
    expect(s.branchCode).toBe("FAIRVIEW");
    expect(s.rows).toEqual([{ date: "2026-11-24", cents: 100000, line: 3 }]);
    expect(s.problems).toEqual([]);
    expect(s.fileTotal).toBe(100000);
  });
});
