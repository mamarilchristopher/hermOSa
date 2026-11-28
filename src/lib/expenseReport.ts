// Expense report, format A "One-page summary" (CHRIS Nov 28 2026, v0.102.4): sales, expenses, profit and margin for a
// period, money by category against the period before, and per-branch profit. Pure: the page loads, this builds.
import { AD_VAT, lastDay, linesOf, shiftMonth, type AdsAuto, type Branch, type Category, type Expense, type Line, type PayrollAuto, type Scope } from "./expenses";

export { AD_VAT };
export type PeriodKind = "month" | "cutoff" | "quarter" | "year" | "custom";
export type Period = {
  kind: PeriodKind; at: string; from: string; to: string; label: string;
  /** The end actually counted: `to`, or today while the period is still running. */
  upTo: string; partial: boolean;
  prevFrom: string; prevTo: string; prevLabel: string;
  prevAt: string | null; nextAt: string | null;
};

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const pad = (n: number) => String(n).padStart(2, "0");
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
export const addDays = (d: string, n: number) => iso(ms(d) + n * 86400000);
export const daysBetween = (a: string, b: string) => Math.round((ms(b) - ms(a)) / 86400000);
const monthEnd = (ym: string) => `${ym}-${pad(lastDay(ym))}`;
const isDate = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(ms(s)) && iso(ms(s)) === s;
const MAX_CUSTOM = 366;

/** "Nov 1–15, 2026", "Nov 28 – Dec 3, 2026", "Dec 30, 2025 – Jan 2, 2026". */
export function rangeLabel(from: string, to: string): string {
  const [fy, fm, fd] = [from.slice(0, 4), Number(from.slice(5, 7)), Number(from.slice(8))];
  const [ty, tm, td] = [to.slice(0, 4), Number(to.slice(5, 7)), Number(to.slice(8))];
  if (from === to) return `${MON[fm - 1]} ${fd}, ${fy}`;
  if (fy !== ty) return `${MON[fm - 1]} ${fd}, ${fy} – ${MON[tm - 1]} ${td}, ${ty}`;
  if (fm !== tm) return `${MON[fm - 1]} ${fd} – ${MON[tm - 1]} ${td}, ${fy}`;
  return `${MON[fm - 1]} ${fd}–${td}, ${fy}`;
}

/** One period's from/to/label from its key. Returns null for a malformed key. */
function span(kind: Exclude<PeriodKind, "custom">, at: string): { from: string; to: string; label: string } | null {
  if (kind === "month") {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(at)) return null;
    return { from: `${at}-01`, to: monthEnd(at), label: `${LONG[Number(at.slice(5)) - 1]} ${at.slice(0, 4)}` };
  }
  if (kind === "cutoff") {
    const m = /^(\d{4}-(?:0[1-9]|1[0-2]))-([12])$/.exec(at);
    if (!m) return null;
    const [from, to] = m[2] === "1" ? [`${m[1]}-01`, `${m[1]}-15`] : [`${m[1]}-16`, monthEnd(m[1])];
    return { from, to, label: `${rangeLabel(from, to)} cutoff` };
  }
  if (kind === "quarter") {
    const m = /^(\d{4})-Q([1-4])$/.exec(at);
    if (!m) return null;
    const q = Number(m[2]), first = `${m[1]}-${pad(q * 3 - 2)}`, last = `${m[1]}-${pad(q * 3)}`;
    return { from: `${first}-01`, to: monthEnd(last), label: `Q${q} ${m[1]} (${MON[q * 3 - 3]}–${MON[q * 3 - 1]})` };
  }
  if (!/^\d{4}$/.test(at)) return null;
  return { from: `${at}-01-01`, to: `${at}-12-31`, label: `Year ${at}` };
}

function shiftAt(kind: Exclude<PeriodKind, "custom">, at: string, n: number): string {
  if (kind === "month") return shiftMonth(at, n);
  if (kind === "cutoff") {
    const i = Number(at.slice(0, 4)) * 24 + (Number(at.slice(5, 7)) - 1) * 2 + (Number(at.slice(8)) - 1) + n;
    return `${Math.floor(i / 24)}-${pad(Math.floor((i % 24) / 2) + 1)}-${(i % 2) + 1}`;
  }
  if (kind === "quarter") {
    const i = Number(at.slice(0, 4)) * 4 + Number(at.slice(6)) - 1 + n;
    return `${Math.floor(i / 4)}-Q${(i % 4) + 1}`;
  }
  return String(Number(at) + n);
}

/** The key of the period that holds `day`. */
export function currentAt(kind: Exclude<PeriodKind, "custom">, day: string): string {
  const ym = day.slice(0, 7);
  if (kind === "month") return ym;
  if (kind === "cutoff") return `${ym}-${Number(day.slice(8)) <= 15 ? 1 : 2}`;
  if (kind === "quarter") return `${day.slice(0, 4)}-Q${Math.ceil(Number(day.slice(5, 7)) / 3)}`;
  return day.slice(0, 4);
}

/**
 * The report period from the address bar. A period still running counts up to today, and the period before is cut at
 * the same number of days so ▲▼ compare like with like. Custom ranges compare with the same number of days just before.
 */
export function periodOf(sp: { period?: string; at?: string; from?: string; to?: string }, today: string): Period {
  const kind: PeriodKind = (["month", "cutoff", "quarter", "year", "custom"] as const).find((k) => k === sp.period) ?? "month";
  if (kind === "custom") {
    let to = isDate(sp.to) && sp.to! <= today ? sp.to! : today;
    let from = isDate(sp.from) ? sp.from! : `${to.slice(0, 7)}-01`;
    if (from > to) [from, to] = [to, from];
    if (daysBetween(from, to) >= MAX_CUSTOM) from = addDays(to, -(MAX_CUSTOM - 1));
    const n = daysBetween(from, to) + 1;
    const prevTo = addDays(from, -1), prevFrom = addDays(from, -n);
    return { kind, at: "", from, to, label: rangeLabel(from, to), upTo: to, partial: false, prevFrom, prevTo, prevLabel: rangeLabel(prevFrom, prevTo), prevAt: null, nextAt: null };
  }
  const now = currentAt(kind, today);
  let at = sp.at && span(kind, sp.at) ? sp.at : now;
  if (span(kind, at)!.from > today) at = now;
  const cur = span(kind, at)!;
  const prevAt = shiftAt(kind, at, -1), prev = span(kind, prevAt)!;
  const partial = cur.to > today;
  const upTo = partial ? today : cur.to;
  const prevTo = partial ? [addDays(prev.from, daysBetween(cur.from, upTo)), prev.to].sort()[0] : prev.to;
  const prevLabel = partial ? rangeLabel(prev.from, prevTo) : prev.label.replace(/ cutoff$/, "");
  const nextAt = at === now ? null : shiftAt(kind, at, 1);
  return { kind, at, from: cur.from, to: cur.to, label: cur.label, upTo, partial, prevFrom: prev.from, prevTo, prevLabel, prevAt, nextAt };
}

/** Every money-out line dated from..to (typed expenses, payroll cutoffs ending in it, ad spend with VAT). */
export function linesBetween(from: string, to: string, cats: Category[], expenses: Expense[], payroll: PayrollAuto[], ads: AdsAuto[], branches: Branch[]): Line[] {
  const e = expenses.filter((x) => x.spent_on >= from && x.spent_on <= to);
  const p = payroll.filter((x) => x.end >= from && x.end <= to);
  // Daily ad rows inside the range; a month from the monthly table counts when its month starts inside the range.
  const a = ads.filter((x) => (x.monthly ? x.d.slice(0, 7) >= from.slice(0, 7) && x.d.slice(0, 7) <= to.slice(0, 7) && `${x.d.slice(0, 7)}-01` >= from : x.d >= from && x.d <= to));
  const out: Line[] = [];
  for (let ym = from.slice(0, 7); ym <= to.slice(0, 7); ym = shiftMonth(ym, 1)) {
    const end = monthEnd(ym) < to ? monthEnd(ym) : to;
    out.push(...linesOf(ym, end, cats, e, p, a, branches).map((l) => (l.auto === "META_ADS" ? { ...l, key: `${l.key}-${ym}` } : l)));
  }
  return out;
}

export type ReportRow = { id: string; name: string; cents: number; prev: number };
export type ReportGroup = { key: string; label: string; rows: ReportRow[]; cents: number; prev: number };
export type ReportBranch = { id: string; name: string; sales: number; own: number; shared: number; left: number; margin: number | null };
export type Report = {
  sales: number | null; prevSales: number | null; spent: number; prevSpent: number;
  left: number | null; prevLeft: number | null; margin: number | null; prevMargin: number | null;
  groups: ReportGroup[]; branches: ReportBranch[] | null; shared: number; entries: number; receipts: number; adsThrough: string | null; hasAds: boolean;
};

const GROUPS: { key: string; label: string }[] = [
  { key: "PEOPLE", label: "People" }, { key: "MARKETING", label: "Marketing" }, { key: "FIXED", label: "Fixed costs" },
  { key: "CLINIC", label: "Clinic" }, { key: "BUSINESS", label: "Business" }, { key: "SHARED", label: "Shared" },
];
const groupOf = (c: Category | undefined) => (!c ? "BUSINESS" : c.auto_source === "PAYROLL" ? "PEOPLE" : c.auto_source === "META_ADS" ? "MARKETING" : c.grp === "AUTO" ? "BUSINESS" : c.grp);

/** Splits company-wide costs by each branch's share of sales (evenly when there are no sales). */
const shareOf = (b: string, sales: Map<string, number>, n: number) => {
  const t = [...sales.values()].reduce((s, v) => s + v, 0);
  return t > 0 ? (sales.get(b) ?? 0) / t : 1 / Math.max(1, n);
};

export function buildReport(input: {
  period: Period; scope: Scope; branches: Branch[]; cats: Category[]; expenses: Expense[];
  payroll: PayrollAuto[]; ads: AdsAuto[]; prevPayroll?: PayrollAuto[]; prevAds?: AdsAuto[];
  sales: Map<string, number>; prevSales: Map<string, number>;
}): Report {
  const { period: p, scope, branches, cats } = input;
  const cur = linesBetween(p.from, p.upTo, cats, input.expenses, input.payroll, input.ads, branches);
  const prev = linesBetween(p.prevFrom, p.prevTo, cats, input.expenses, input.prevPayroll ?? input.payroll, input.prevAds ?? input.ads, branches);
  const n = branches.length;
  const scoped = (ls: Line[], sales: Map<string, number>): Line[] => {
    if (scope === null) return ls;
    if (scope === "company") return ls.filter((l) => l.branch_id === null);
    const own = ls.filter((l) => l.branch_id === scope);
    const part = Math.round(ls.filter((l) => l.branch_id === null).reduce((s, l) => s + l.cents, 0) * shareOf(scope, sales, n));
    return part > 0 ? [...own, { key: "share", date: "", branch_id: scope, category: "Share of company-wide costs", categoryId: "share", text: "", sub: "", cents: part, auto: null }] : own;
  };
  const c = scoped(cur, input.sales), pv = scoped(prev, input.prevSales);
  const sum = (ls: Line[]) => ls.reduce((s, l) => s + l.cents, 0);
  const total = (m: Map<string, number>) => [...m.values()].reduce((s, v) => s + v, 0);
  const salesOf = (m: Map<string, number>) => (scope === "company" ? null : scope === null ? total(m) : m.get(scope) ?? 0);
  const sales = salesOf(input.sales), prevSales = salesOf(input.prevSales);
  const spent = sum(c), prevSpent = sum(pv);
  const left = sales === null ? null : sales - spent, prevLeft = prevSales === null ? null : prevSales - prevSpent;

  const cat = new Map(cats.map((x) => [x.id, x]));
  const rows = new Map<string, ReportRow & { g: string }>();
  const add = (ls: Line[], f: "cents" | "prev") => {
    for (const l of ls) {
      const k = cat.get(l.categoryId);
      const r = rows.get(l.categoryId) ?? { id: l.categoryId, g: l.categoryId === "share" ? "SHARED" : groupOf(k),
        name: l.categoryId === "share" ? "Share of company-wide costs" : k ? (k.auto_source === "META_ADS" ? `${k.name}*` : k.name) : l.category, cents: 0, prev: 0 };
      r[f] += l.cents;
      rows.set(l.categoryId, r);
    }
  };
  add(c, "cents"); add(pv, "prev");
  const groups: ReportGroup[] = GROUPS.map((g) => {
    const rs = [...rows.values()].filter((r) => r.g === g.key && (r.cents > 0 || r.prev > 0)).sort((a, b) => b.cents - a.cents || b.prev - a.prev)
      .map(({ g: _g, ...r }) => r);
    return { ...g, rows: rs, cents: rs.reduce((s, r) => s + r.cents, 0), prev: rs.reduce((s, r) => s + r.prev, 0) };
  }).filter((g) => g.rows.length);

  const shared = cur.filter((l) => l.branch_id === null).reduce((s, l) => s + l.cents, 0);
  const branchRows: ReportBranch[] | null = scope !== null ? null : branches.map((b) => {
    const s = input.sales.get(b.id) ?? 0;
    const own = cur.filter((l) => l.branch_id === b.id).reduce((t, l) => t + l.cents, 0);
    const sh = Math.round(shared * shareOf(b.id, input.sales, n));
    return { id: b.id, name: b.name, sales: s, own, shared: sh, left: s - own - sh, margin: s > 0 ? (s - own - sh) / s : null };
  });
  // Rounding the shares can leave a peso or two; give it to the biggest branch so the columns add up.
  if (branchRows?.length) {
    const diff = shared - branchRows.reduce((t, b) => t + b.shared, 0);
    if (diff) { const big = branchRows.reduce((m, b) => (b.sales > m.sales ? b : m)); big.shared += diff; big.left -= diff; big.margin = big.sales > 0 ? big.left / big.sales : null; }
  }
  const typed = c.filter((l) => l.id);
  const adsThrough = input.ads.filter((a) => !a.monthly && a.d >= p.from && a.d <= p.upTo).reduce<string | null>((m, a) => (!m || a.d > m ? a.d : m), null);
  return {
    sales, prevSales, spent, prevSpent, left, prevLeft,
    margin: sales && left !== null ? left / sales : null, prevMargin: prevSales && prevLeft !== null ? prevLeft / prevSales : null,
    groups, branches: branchRows, shared, entries: typed.length, receipts: typed.filter((l) => (l.receipts ?? 0) > 0).length,
    adsThrough, hasAds: c.some((l) => l.auto === "META_ADS"),
  };
}

/** Rows for the Excel download: one sheet-like table of the report (UTF-8 CSV with a BOM so Excel shows ₱ and ñ). */
export function reportCsv(r: Report, title: string, scopeLabel: string, prevLabel: string): string {
  const peso = (c: number | null) => (c === null ? "" : (c / 100).toFixed(2));
  const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const out: string[][] = [[title], [scopeLabel], [], ["Summary", "This period", prevLabel],
    ["Sales", peso(r.sales), peso(r.prevSales)], ["Expenses", peso(r.spent), peso(r.prevSpent)], ["Left (profit)", peso(r.left), peso(r.prevLeft)],
    ["Margin %", r.margin === null ? "" : (r.margin * 100).toFixed(1), r.prevMargin === null ? "" : (r.prevMargin * 100).toFixed(1)], [],
    ["Group", "Category", "This period", prevLabel]];
  for (const g of r.groups) {
    for (const x of g.rows) out.push([g.label, x.name, peso(x.cents), peso(x.prev)]);
    out.push([g.label, `${g.label} total`, peso(g.cents), peso(g.prev)]);
  }
  out.push(["", "Total expenses", peso(r.spent), peso(r.prevSpent)]);
  if (r.branches) {
    out.push([], ["Branch", "Sales", "Own costs", "Share of company-wide", "Left", "Margin %"]);
    for (const b of r.branches) out.push([b.name, peso(b.sales), peso(b.own), peso(b.shared), peso(b.left), b.margin === null ? "" : (b.margin * 100).toFixed(1)]);
  }
  if (r.hasAds) out.push([], ["* Meta ad spend includes 12% VAT"]);
  return `﻿${out.map((row) => row.map(q).join(",")).join("\r\n")}\r\n`;
}
