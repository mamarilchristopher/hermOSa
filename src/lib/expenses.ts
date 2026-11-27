// Expenses dashboard (CHRIS Nov 28, update-0100): money out next to sales, per month, per branch.
// Pure: the page loads expenses, the automatic lines (payroll, Meta ads) and sales; this builds the dashboard.
export const AD_VAT = 1.12; // CHRIS Nov 27: ad money spent is shown with 12% VAT and marked *

export type Category = { id: string; name: string; grp: string; kind: "MONTHLY" | "ONE_OFF" | "AUTO"; auto_source: "PAYROLL" | "META_ADS" | null; budget_cents: number | null; sort: number; active: boolean };
export type Expense = { id: string; branch_id: string | null; category_id: string; spent_on: string; amount_cents: number; description: string; payee: string | null; paid_via: string | null; receipt_paths: string[] };
export type PayrollAuto = { run: string; start: string; end: string; branch_id: string | null; gross_cents: number; people: number };
export type AdsAuto = { d: string; branch: string; cents: number; monthly?: boolean };
export type Branch = { id: string; code: string; name: string };
/** null = every branch and company-wide; "company" = company-wide only; else a branch id. */
export type Scope = null | "company" | string;

export type Line = { key: string; date: string; branch_id: string | null; category: string; categoryId: string; text: string; sub: string; cents: number; auto: "PAYROLL" | "META_ADS" | null; id?: string; receipts?: number };
export type CatRow = { id: string; name: string; auto: boolean; cents: number; prev: number; budget: number | null };
export type Due = { categoryId: string; category: string; branch_id: string | null; expected: number; day: number; overdue: boolean; lastText: string; payee: string | null };
export type BranchRow = { id: string; name: string; sales: number; spent: number; left: number; margin: number | null };
export type Dashboard = {
  spent: number; prevSpent: number; sales: number | null; prevSales: number | null; left: number | null; margin: number | null;
  due: Due[]; dueDone: number; dueTotal: number; cats: CatRow[]; branches: BranchRow[]; lines: Line[];
  adsThrough: string | null; vsLabel: string;
};

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");
export const lastDay = (ym: string) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate();
export const shiftMonth = (ym: string, n: number) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1 + n, 1)).toISOString().slice(0, 7);

/**
 * Every money-out line of a month: typed expenses, salaries from final payroll cutoffs (dated the cutoff's last day),
 * and Meta ad spend with VAT (one line per branch per month, dated the last day with data).
 */
export function linesOf(ym: string, upTo: string, cats: Category[], expenses: Expense[], payroll: PayrollAuto[], ads: AdsAuto[], branches: Branch[]): Line[] {
  const cat = new Map(cats.map((c) => [c.id, c]));
  const bName = new Map(branches.map((b) => [b.id, b.name]));
  const byCode = new Map(branches.map((b) => [b.code, b.id]));
  const payCat = cats.find((c) => c.auto_source === "PAYROLL");
  const adsCat = cats.find((c) => c.auto_source === "META_ADS");
  const out: Line[] = [];
  for (const e of expenses) {
    if (!e.spent_on.startsWith(ym) || e.spent_on > upTo) continue;
    const c = cat.get(e.category_id);
    out.push({ key: e.id, id: e.id, date: e.spent_on, branch_id: e.branch_id, category: c?.name ?? "Other", categoryId: e.category_id, text: e.description,
      sub: [c?.name, e.branch_id ? bName.get(e.branch_id) : "Company-wide", e.payee].filter(Boolean).join(" · "), cents: e.amount_cents, auto: null, receipts: e.receipt_paths.length });
  }
  if (payCat) {
    const runs = new Map<string, { start: string; end: string; per: Map<string | null, number>; people: number }>();
    for (const p of payroll) {
      if (!p.end.startsWith(ym) || p.end > upTo) continue;
      const r = runs.get(p.run) ?? { start: p.start, end: p.end, per: new Map(), people: 0 };
      const b = p.branch_id && bName.has(p.branch_id) ? p.branch_id : null; // HQ / work-from-home staff = company-wide
      r.per.set(b, (r.per.get(b) ?? 0) + p.gross_cents); r.people += p.people;
      runs.set(p.run, r);
    }
    for (const [run, r] of runs) for (const [b, cents] of r.per) {
      const label = `${MON[Number(r.start.slice(5, 7)) - 1]} ${Number(r.start.slice(8))}–${Number(r.end.slice(8))}`;
      out.push({ key: `pay-${run}-${b}`, date: r.end, branch_id: b, category: payCat.name, categoryId: payCat.id, text: `Salaries, ${label} cutoff`,
        sub: `Auto from payroll · ${b ? bName.get(b) : "Company-wide"}`, cents, auto: "PAYROLL" });
    }
  }
  if (adsCat) {
    const per = new Map<string, { cents: number; last: string; monthly: boolean }>();
    for (const a of ads) {
      if (!a.d.startsWith(ym) || (!a.monthly && a.d > upTo)) continue;
      const b = byCode.get(a.branch);
      if (!b) continue;
      const r = per.get(b) ?? { cents: 0, last: a.d, monthly: false };
      r.cents += a.cents; r.last = a.d > r.last ? a.d : r.last; r.monthly ||= !!a.monthly;
      per.set(b, r);
    }
    for (const [b, r] of per) {
      const date = r.monthly ? (upTo.startsWith(ym) ? upTo : `${ym}-${pad(lastDay(ym))}`) : r.last;
      out.push({ key: `ads-${b}`, date, branch_id: b, category: adsCat.name, categoryId: adsCat.id, text: "Meta ad spend*",
        sub: `Auto from ${r.monthly ? "the monthly ad spend" : `Windsor, through ${MON[Number(r.last.slice(5, 7)) - 1]} ${Number(r.last.slice(8))}`} · ${bName.get(b)}`,
        cents: Math.round(r.cents * AD_VAT), auto: "META_ADS" });
    }
  }
  return out.sort((a, b) => b.date.localeCompare(a.date) || b.cents - a.cents);
}

const inScope = (scope: Scope, branch: string | null) => scope === null || (scope === "company" ? branch === null : branch === scope);

/**
 * The dashboard for one month and scope. `today` cuts the current month (and last month at the same day number for ▲▼).
 * Sales are per branch id for the month (approved/typed daily sales); company-wide costs are shared by sales.
 */
export function buildDashboard(input: {
  ym: string; today: string; scope: Scope; branches: Branch[]; cats: Category[]; expenses: Expense[]; payroll: PayrollAuto[]; ads: AdsAuto[];
  sales: Map<string, number>; prevSales: Map<string, number>;
}): Dashboard {
  const { ym, today, scope, branches, cats } = input;
  const isNow = today.startsWith(ym);
  const pm = shiftMonth(ym, -1);
  const upTo = isNow ? today : `${ym}-${pad(lastDay(ym))}`;
  const pDay = isNow ? Math.min(Number(today.slice(8)), lastDay(pm)) : lastDay(pm);
  const pUpTo = `${pm}-${pad(pDay)}`;
  const cur = linesOf(ym, upTo, cats, input.expenses, input.payroll, input.ads, branches);
  const prevAll = linesOf(pm, `${pm}-${pad(lastDay(pm))}`, cats, input.expenses, input.payroll, input.ads, branches);
  const prev = prevAll.filter((l) => l.date <= pUpTo || (l.auto === "META_ADS" && l.sub.includes("monthly")));

  // Company-wide costs shared by each branch's share of sales (for a branch tab and the per-branch rows).
  const totalSales = [...input.sales.values()].reduce((s, v) => s + v, 0);
  const share = (b: string, sales: Map<string, number>) => {
    const t = [...sales.values()].reduce((s, v) => s + v, 0);
    return t > 0 ? (sales.get(b) ?? 0) / t : 1 / Math.max(1, branches.length);
  };
  const scoped = (ls: Line[], sales: Map<string, number>): Line[] => {
    if (scope === null || scope === "company") return ls.filter((l) => inScope(scope, l.branch_id));
    const own = ls.filter((l) => l.branch_id === scope);
    const shared = ls.filter((l) => l.branch_id === null).reduce((s, l) => s + l.cents, 0);
    const part = Math.round(shared * share(scope, sales));
    return part > 0 ? [...own, { key: "share", date: "", branch_id: scope, category: "Share of company-wide costs", categoryId: "share", text: "Share of company-wide costs", sub: "split by sales", cents: part, auto: null }] : own;
  };
  const curS = scoped(cur, input.sales), prevS = scoped(prev, input.prevSales);
  const sum = (ls: Line[]) => ls.reduce((s, l) => s + l.cents, 0);
  const spent = sum(curS), prevSpent = sum(prevS);
  const salesOf = (m: Map<string, number>) => (scope === "company" ? null : scope === null ? [...m.values()].reduce((s, v) => s + v, 0) : m.get(scope) ?? 0);
  const sales = salesOf(input.sales), prevSales = salesOf(input.prevSales);
  const left = sales === null ? null : sales - spent;

  // Due this month: monthly bills that came in last month (per category and branch) and haven't this month.
  const monthly = new Set(cats.filter((c) => c.kind === "MONTHLY").map((c) => c.id));
  const k = (l: Line) => `${l.categoryId}|${l.branch_id ?? ""}`;
  const have = new Set(cur.filter((l) => monthly.has(l.categoryId) && inScope(scope === null || scope === "company" ? scope : scope, l.branch_id)).map(k));
  const lastMonth = new Map<string, { cents: number; day: number; text: string; payee: string | null; l: Line }>();
  for (const l of prevAll) {
    if (!monthly.has(l.categoryId) || !inScope(scope, l.branch_id)) continue;
    const e = input.expenses.find((x) => x.id === l.id);
    const r = lastMonth.get(k(l)) ?? { cents: 0, day: Number(l.date.slice(8)), text: l.text, payee: e?.payee ?? null, l };
    r.cents += l.cents; r.day = Math.max(r.day, Number(l.date.slice(8)));
    lastMonth.set(k(l), r);
  }
  const due: Due[] = [];
  let dueDone = 0;
  for (const [key, r] of lastMonth) {
    if (have.has(key)) { dueDone += 1; continue; }
    const day = Math.min(r.day, lastDay(ym));
    due.push({ categoryId: r.l.categoryId, category: r.l.category, branch_id: r.l.branch_id, expected: r.cents, day, lastText: r.text, payee: r.payee,
      overdue: isNow ? Number(today.slice(8)) > day : !have.has(key) });
  }
  for (const key of have) if (!lastMonth.has(key)) dueDone += 1;
  due.sort((a, b) => Number(b.overdue) - Number(a.overdue) || a.day - b.day || b.expected - a.expected);

  // Where the money goes.
  const catMap = new Map<string, CatRow>();
  const add = (ls: Line[], f: "cents" | "prev") => {
    for (const l of ls) {
      const c = cats.find((x) => x.id === l.categoryId);
      const r = catMap.get(l.categoryId) ?? { id: l.categoryId, name: c ? (c.auto_source === "META_ADS" ? `${c.name}*` : c.name) : l.category, auto: !!l.auto, cents: 0, prev: 0, budget: c?.budget_cents ?? null };
      r[f] += l.cents;
      catMap.set(l.categoryId, r);
    }
  };
  add(curS, "cents"); add(prevS, "prev");
  const catRows = [...catMap.values()].filter((r) => r.cents > 0 || r.prev > 0).sort((a, b) => b.cents - a.cents || b.prev - a.prev);

  // Per branch: own costs + a share of company-wide ones, against that branch's sales.
  const sharedCur = cur.filter((l) => l.branch_id === null).reduce((s, l) => s + l.cents, 0);
  const branchRows: BranchRow[] = branches.map((b) => {
    const s = input.sales.get(b.id) ?? 0;
    const own = cur.filter((l) => l.branch_id === b.id).reduce((t, l) => t + l.cents, 0);
    const sp = own + Math.round(sharedCur * (totalSales > 0 ? s / totalSales : 1 / Math.max(1, branches.length)));
    return { id: b.id, name: b.name, sales: s, spent: sp, left: s - sp, margin: s > 0 ? (s - sp) / s : null };
  });

  const adsThrough = input.ads.filter((a) => !a.monthly).reduce<string | null>((m, a) => (!m || a.d > m ? a.d : m), null);
  const vsLabel = isNow ? `${MON[Number(pm.slice(5, 7)) - 1]} 1–${pDay}` : MON[Number(pm.slice(5, 7)) - 1];
  return {
    spent, prevSpent, sales, prevSales, left, margin: sales && left !== null ? left / sales : null,
    due, dueDone, dueTotal: dueDone + due.length, cats: catRows, branches: branchRows,
    lines: curS.filter((l) => l.key !== "share"), adsThrough, vsLabel,
  };
}
