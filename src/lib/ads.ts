/**
 * Business › Ads (update-0096, CHRIS Nov 27): Meta ad spend against sales, per branch and service, and where sales came from.
 * Money rule (CHRIS Nov 27): money SPENT is shown with 12% VAT and a * (₱1,000*); RECOMMENDED budgets are pre-VAT, no *.
 * Branch rule (CHRIS Nov 27): ad spend belongs to the branch whose Facebook page the ad ran on, not its name or ad account.
 */

export const VAT = 1.12;
export const withVat = (cents: number) => Math.round(cents * VAT);
/** Below this ROAS (total sales ÷ spend with VAT) an ad line is flagged. */
export const ROAS_FLOOR = 3.5;

export type AdService = "HIKO" | "GLUTA" | "OTHER";
export const AD_SERVICES: AdService[] = ["HIKO", "GLUTA", "OTHER"];
export const SERVICE_LABEL: Record<AdService, string> = { HIKO: "Hiko", GLUTA: "Gluta", OTHER: "Other" };

export type Source = "AD" | "PAGE" | "WALK_IN" | "REFERRAL" | "RETURNING" | "OTHER";
export const SOURCES: Source[] = ["AD", "PAGE", "WALK_IN", "REFERRAL", "RETURNING", "OTHER"];
export const SOURCE_LABEL: Record<Source, string> = {
  AD: "Ad (Messenger)", PAGE: "Page / organic", WALK_IN: "Walk-in", REFERRAL: "Referral", RETURNING: "Returning client", OTHER: "Other",
};

/** Which ad line a Service log item belongs to (by its name): Hiko, Gluta (drips and IV glow included), or other. */
export function adServiceOf(name: string): AdService {
  const s = name.toLowerCase();
  if (s.includes("hiko")) return "HIKO";
  if (/gluta|drip|lux queen|brilliant|carnitine/.test(s)) return "GLUTA";
  return "OTHER";
}

/** All-branch shares of sales per ad line from the Nov 1–24 2026 service logs (CHRIS's method), used when a branch has no log yet. */
export const NOV_SHARES: Record<string, Record<AdService, number>> = {
  QC_MAIN: { HIKO: 0.748, GLUTA: 0.023, OTHER: 0.229 },
  FAIRVIEW: { HIKO: 0.532, GLUTA: 0.125, OTHER: 0.343 },
  STA_MARIA: { HIKO: 0.444, GLUTA: 0.277, OTHER: 0.279 },
  MARIKINA: { HIKO: 0.565, GLUTA: 0.259, OTHER: 0.176 },
};

/** A normal month's plan (pre-VAT pesos), from the Nov 27 ROAS check: https://claude.ai/artifact/NBhJKh5fqUpE7SG6pVQsTD */
export const PLAN: { code: string; hiko: number; gluta: number; note: string }[] = [
  { code: "QC_MAIN", hiko: 95_000, gluta: 0, note: "Hiko about halved: November kept sales on half the spend. Gluta stays off (1.2x)." },
  { code: "FAIRVIEW", hiko: 60_000, gluta: 15_000, note: "Hiko trimmed (its lowest return, 2.8x); Gluta back on." },
  { code: "STA_MARIA", hiko: 35_000, gluta: 20_000, note: "Hiko trimmed (3.0x); Gluta grown, about 10x." },
  { code: "MARIKINA", hiko: 50_000, gluta: 20_000, note: "Best return on the least money: grow both." },
];
export const PLAN_TESTING = 25_000;
export const PLAN_DECEMBER = 360_000;

/** Best and worst ads by cost per new message, Jun 2025 – Nov 2026 (₱30k+ spent). Spend is pre-VAT centavos. */
export const CREATIVES: { name: string; where: string; spend: number; messages: number; best: boolean }[] = [
  { name: "NEW- AFFORDABLE HIKO NOSE MARIKINA", where: "Marikina", spend: 22_557_857, messages: 8842, best: true },
  { name: "OLD- WHY SHOULD I CHOOSE HIKO", where: "Sta. Maria", spend: 4_622_946, messages: 1786, best: true },
  { name: "Hiko nose failed x testimonial", where: "Sta. Maria", spend: 4_035_179, messages: 1377, best: true },
  { name: "OLD- HIKO NOSE 2 YEARS", where: "Marikina", spend: 13_563_036, messages: 4521, best: true },
  { name: "Don't risk it", where: "QC Main, Fairview", spend: 48_919_286, messages: 15474, best: true },
  { name: "NEW- 8,999 Hiko Package", where: "QC Main", spend: 3_061_964, messages: 529, best: false },
  { name: "NEW- WORTH IT BA MAGPAHIKO?", where: "QC Main, Fairview", spend: 9_764_196, messages: 1602, best: false },
  { name: "Hiko Vid A", where: "QC Main, Fairview, Sta. Maria", spend: 5_560_893, messages: 886, best: false },
  { name: "Hiko disappointment - Vid", where: "QC Main, Fairview, Sta. Maria", spend: 3_340_446, messages: 525, best: false },
  { name: "Client pic (Gluta)", where: "QC Main", spend: 6_975_179, messages: 1075, best: false },
  { name: "Hiko Vid C", where: "QC Main, Fairview, Sta. Maria", spend: 4_597_054, messages: 431, best: false },
];

export type SpendRow = { month: string; branch_id: string; service: AdService; spend_cents: number; messages: number; through: string | null };

/** Months (YYYY-MM) that have ad spend, oldest first. */
export const spendMonths = (rows: SpendRow[]) => [...new Set(rows.map((r) => r.month.slice(0, 7)))].sort();

export type PeriodOpt = { key: string; label: string; months: string[] };
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const monthName = (ym: string, year = true) => `${MON[Number(ym.slice(5, 7)) - 1]}${year ? ` ${ym.slice(0, 4)}` : ""}`;

/** Period choices: this year so far, the last 3 full months, the last 12 months, and each of the last 6 months. */
export function periodOptions(months: string[], thisMonth: string): PeriodOpt[] {
  if (!months.length) return [];
  const last = months[months.length - 1];
  const full = months.filter((m) => m < thisMonth);
  const out: PeriodOpt[] = [];
  const ytd = months.filter((m) => m.slice(0, 4) === last.slice(0, 4));
  out.push({ key: "ytd", label: `${last.slice(0, 4)} so far`, months: ytd });
  if (full.length >= 3) out.push({ key: "3m", label: `${monthName(full[full.length - 3], false)}–${monthName(full[full.length - 1], false)}`, months: full.slice(-3) });
  out.push({ key: "12m", label: "Last 12 months", months: months.slice(-12) });
  for (const m of months.slice(-6).reverse()) out.push({ key: m, label: monthName(m), months: [m] });
  return out;
}

export type Line = { spend: number; messages: number; sales: number };
export const roas = (l: { spend: number; sales: number }) => (l.spend > 0 ? l.sales / withVat(l.spend) : null);
export const perMessage = (l: { spend: number; messages: number }) => (l.messages > 0 ? withVat(l.spend) / l.messages : null);

/**
 * Spend, messages and sales per branch and per branch × ad line for the chosen months.
 * sales: branch → month → cents (declared sales). shares: branch → ad line → share of that branch's sales.
 */
export function summarize(rows: SpendRow[], months: string[], sales: Map<string, Map<string, number>>, branchIds: string[], shares: Map<string, Record<AdService, number>>) {
  const inP = new Set(months);
  const branch = new Map<string, Line>(branchIds.map((id) => [id, { spend: 0, messages: 0, sales: 0 }]));
  const line = new Map<string, Line>();
  for (const r of rows) {
    if (!inP.has(r.month.slice(0, 7)) || !branch.has(r.branch_id)) continue;
    const b = branch.get(r.branch_id)!;
    b.spend += Number(r.spend_cents); b.messages += Number(r.messages);
    const k = `${r.branch_id}|${r.service}`;
    const l = line.get(k) ?? { spend: 0, messages: 0, sales: 0 };
    l.spend += Number(r.spend_cents); l.messages += Number(r.messages);
    line.set(k, l);
  }
  for (const id of branchIds) {
    const b = branch.get(id)!;
    for (const m of months) b.sales += sales.get(id)?.get(m) ?? 0;
    const sh = shares.get(id);
    for (const s of AD_SERVICES) {
      const k = `${id}|${s}`;
      const l = line.get(k) ?? { spend: 0, messages: 0, sales: 0 };
      l.sales = Math.round(b.sales * (sh?.[s] ?? 0));
      line.set(k, l);
    }
  }
  const total = [...branch.values()].reduce((t, b) => ({ spend: t.spend + b.spend, messages: t.messages + b.messages, sales: t.sales + b.sales }), { spend: 0, messages: 0, sales: 0 });
  return { branch, line, total };
}

export type LogForSource = { id: string; amount_paid_cents: number; session_no: number | null; promo_client_id: string | null; booking_id: string | null };

/**
 * Where a sale came from. A source set by owners/the GM wins. Otherwise: a later package session = returning client;
 * a booking made from a Facebook/Instagram chat = ad (most chats start from a click-to-Messenger ad); a walk-in booking = walk-in.
 * Anything else stays unknown until someone tags it.
 */
export function sourceOf(log: LogForSource, manual: Source | undefined, platform: string | undefined): { source: Source | null; auto: boolean } {
  if (manual) return { source: manual, auto: false };
  if ((log.session_no ?? 1) > 1) return { source: "RETURNING", auto: true };
  if (platform === "FACEBOOK" || platform === "INSTAGRAM") return { source: "AD", auto: true };
  if (platform === "WALK_IN") return { source: "WALK_IN", auto: true };
  return { source: null, auto: false };
}

export type SourceSummary = { total: number; known: number; bySource: Record<Source, number>; tagged: number; auto: number };
export function summarizeSources(items: { cents: number; source: Source | null; auto: boolean }[]): SourceSummary {
  const bySource = Object.fromEntries(SOURCES.map((s) => [s, 0])) as Record<Source, number>;
  let total = 0, known = 0, tagged = 0, auto = 0;
  for (const it of items) {
    if (it.cents <= 0) continue;
    total += it.cents;
    if (!it.source) continue;
    known += it.cents;
    bySource[it.source] += it.cents;
    if (it.auto) auto += it.cents; else tagged += it.cents;
  }
  return { total, known, bySource, tagged, auto };
}

/**
 * Ad-sourced ROAS. With every sale's source known it is ad sales ÷ spend; with part known, the ad share of the known
 * sales is applied to all logged sales (an estimate, shown with its coverage).
 */
export function adRoas(s: SourceSummary, spendCents: number): { value: number; coverage: number; estimated: boolean } | null {
  if (spendCents <= 0 || s.total <= 0 || s.known <= 0) return null;
  const coverage = s.known / s.total;
  const adSales = coverage >= 0.999 ? s.bySource.AD : (s.bySource.AD / s.known) * s.total;
  return { value: adSales / withVat(spendCents), coverage, estimated: coverage < 0.999 };
}

const WORDS: [RegExp, Source][] = [
  [/^(ad|ads|fb ?ad|meta|messenger|boost(ed)?|sponsored)$/, "AD"],
  [/^(page|organic|fb|facebook|ig|instagram|tiktok|post|online)$/, "PAGE"],
  [/^(walk[- ]?in|walkin|wi)$/, "WALK_IN"],
  [/^(referral|referred|ref|friend|refer)$/, "REFERRAL"],
  [/^(returning|repeat|old|existing|regular|package|return)$/, "RETURNING"],
  [/^(other|others)$/, "OTHER"],
];
export const sourceWord = (w: string): Source | null => {
  const s = w.trim().toLowerCase().replace(/[.:]+$/, "");
  for (const [re, src] of WORDS) if (re.test(s)) return src;
  return null;
};

/**
 * Pasted lines like "SL-271126-012 walk-in", old "SL-2611-0012 walk-in" or "SL26110013, ad" (read off sales-log photos) → rows for set_sales_sources.
 * Returns the lines it couldn't read.
 */
export function parseSourceLines(text: string): { rows: { log_no: string; source: Source }[]; bad: string[] } {
  const rows: { log_no: string; source: Source }[] = [];
  const bad: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    // update-0098: new codes SL-DDMMYY-NNN (day first); old codes SL-YYMM-NNNN still work.
    const m = line.match(/S\s*L\s*-?\s*(\d{6}|\d{4})\s*-\s*(\d{1,4})/i) ?? line.match(/S\s*L\s*-?\s*(\d{6}|\d{4})()(?=\D|$)/i) ?? line.match(/S\s*L\s*-?\s*(\d{4})(\d{4})(?=\D|$)/i);
    const rest = m ? line.slice((m.index ?? 0) + m[0].length).replace(/^[\s,;:|\t-]+/, "") : "";
    const src = m ? sourceWord(rest) : null;
    if (!m || !src) { bad.push(line); continue; }
    if (!m[2]) { bad.push(line); continue; }
    rows.push({ log_no: `SL-${m[1]}-${m[2].padStart(m[1].length === 6 ? 3 : 4, "0")}`, source: src });
  }
  return { rows, bad };
}

const BRANCH_WORDS: [RegExp, string][] = [[/^(qc|qc main|main|qc_main)$/, "QC_MAIN"], [/^(fv|fairview)$/, "FAIRVIEW"], [/^(smb|sta\.? ?maria|sta_maria|bulacan)$/, "STA_MARIA"], [/^(mk|marikina)$/, "MARIKINA"]];

/**
 * Monthly spend lines "2026-12, QC Main, Hiko, 95000, 2100" (month, branch, Hiko/Gluta/Other, pesos BEFORE VAT, new messages)
 * → rows for save_ad_spend. An optional 6th field is the last day the figures cover (2026-12-15).
 */
export function parseSpendLines(text: string): { rows: { month: string; branch: string; service: AdService; spend_cents: number; messages: number; through: string | null }[]; bad: string[] } {
  const rows: { month: string; branch: string; service: AdService; spend_cents: number; messages: number; through: string | null }[] = [];
  const bad: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^month\b/i.test(line)) continue;
    // Tabs, ; or | split fields; else ", " (so 95,000 stays one number); else a bare comma.
    const f = (/[\t;|]/.test(line) ? line.split(/\s*[\t;|]\s*/) : /,\s/.test(line) ? line.split(/\s*,\s+/) : line.split(/\s*,\s*/)).map((v) => v.trim());
    const month = f[0]?.match(/^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/);
    const branch = BRANCH_WORDS.find(([re]) => re.test((f[1] ?? "").toLowerCase()))?.[1];
    const service = ({ hiko: "HIKO", gluta: "GLUTA", other: "OTHER" } as Record<string, AdService>)[(f[2] ?? "").toLowerCase()];
    const pesos = Number((f[3] ?? "").replace(/[₱,\s]/g, ""));
    const msgs = f[4] === undefined || f[4] === "" ? 0 : Number(f[4].replace(/[,\s]/g, ""));
    const through = f[5] && /^\d{4}-\d{2}-\d{2}$/.test(f[5]) ? f[5] : null;
    const mo = month ? Number(month[2]) : 0;
    if (!month || mo < 1 || mo > 12 || !branch || !service || !Number.isFinite(pesos) || pesos < 0 || !Number.isInteger(msgs) || msgs < 0 || (f[5] && !through)) { bad.push(line); continue; }
    rows.push({ month: `${month[1]}-${String(mo).padStart(2, "0")}-01`, branch, service, spend_cents: Math.round(pesos * 100), messages: msgs, through });
  }
  return { rows, bad };
}

/** "₱12,345*" — spent money, VAT included. */
export const spent = (preVatCents: number) => `₱${Math.round(withVat(preVatCents) / 100).toLocaleString("en-US")}*`;
/** "₱312K*" — compact spent money, VAT included. */
export const spentK = (preVatCents: number) => {
  const p = withVat(preVatCents) / 100;
  return p >= 1_000_000 ? `₱${(p / 1_000_000).toFixed(2)}M*` : p >= 1_000 ? `₱${Math.round(p / 1_000)}K*` : `₱${Math.round(p)}*`;
};
export const x = (v: number | null) => (v === null || !Number.isFinite(v) ? "–" : `${v.toFixed(1)}x`);
