/**
 * Business › Ads advisor (update-0099, CHRIS Nov 27): per branch × service, what to do with the budget this week, which ads
 * to turn off or copy, how the ad set should be set up, and which library videos to use.
 * Numbers come from the daily Meta feed (ads_feed_rows); the set-up, videos and market radar come from the ads thread's
 * playbook (src/data/adsPlaybook.json). Rules (master plan): change a budget at most once a week, by about 20%, never
 * within 7 days of the last change; raise when weekly ROAS is 5x+ both weeks, cut when under 3.5x two weeks running.
 * Money: spent amounts are VAT-inclusive with a * (feed spend is before VAT); budgets are before VAT.
 */
import type { AdService } from "@/lib/ads";

export const PAGES: Record<string, string> = {
  "103117851723422": "QC_MAIN",
  "101404945363588": "FAIRVIEW",
  "112393681804031": "STA_MARIA",
  "257589974108824": "MARIKINA",
};
export const BRANCH_ORDER = ["QC_MAIN", "FAIRVIEW", "STA_MARIA", "MARIKINA"];
/** Clinic pins, to catch an ad set aimed at another branch's area. */
export const CLINIC_PIN: Record<string, [number, number]> = {
  QC_MAIN: [14.6393, 121.0566], FAIRVIEW: [14.7032, 121.0686], STA_MARIA: [14.8659, 120.9966], MARIKINA: [14.6587, 121.112],
};
export const RAISE_AT = 5;
export const CUT_BELOW = 3.5;
export const STEP = 0.2;
export const LOCK_DAYS = 7;
/** Meta wants about 50 results per ad set per week to leave learning. */
export const LEARN_PER_WEEK = 50;

export type FeedRow = {
  d: string; page: string; cid: string | null; c: string | null; sid: string | null; s: string | null; aid: string; a: string | null;
  sp: number | string | null; im: number | string | null; rc: number | string | null; fq: number | string | null; cl: number | string | null;
  m: number | string | null; sb: number | string | null; cb: number | string | null; ss: string | null; as: string | null;
  /** Ad account id, once the reader returns it (Ads Manager links). */
  act?: string | null;
};
export type Feed = { ok: boolean; from?: string; last_date: string | null; loaded_at: string | null; source: string | null; rows: FeedRow[]; targeting: Record<string, string> };

const n = (v: unknown) => (v === null || v === undefined || v === "" ? 0 : Number(v) || 0);
export const addDay = (d: string, k: number) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + k);
  return t.toISOString().slice(0, 10);
};
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** Which ad line an ad belongs to, by its campaign, ad set and ad names. */
export function serviceOfAd(campaign: string | null, adset: string | null, ad: string | null): AdService {
  const all = `${campaign ?? ""} | ${adset ?? ""} | ${ad ?? ""}`.toLowerCase();
  if (/drip|gluta|lux|glow|non-?\s?invasive/.test(all)) return "GLUTA";
  if (/hiko|nose|contour|vid\+pic|trending|worth it|failed/.test(all)) return "HIKO";
  return "OTHER";
}

export type Totals = { spend: number; msgs: number; impressions: number; clicks: number; reach: number };
const zero = (): Totals => ({ spend: 0, msgs: 0, impressions: 0, clicks: 0, reach: 0 });
const add = (t: Totals, r: FeedRow) => { t.spend += n(r.sp); t.msgs += n(r.m); t.impressions += n(r.im); t.clicks += n(r.cl); t.reach += n(r.rc); };
/** Pesos per chat, VAT included. */
export const perChat = (t: Totals) => (t.msgs > 0 ? (t.spend * 1.12) / t.msgs : null);
const ctr = (t: Totals) => (t.impressions > 0 ? t.clicks / t.impressions : null);

export type Targeting = {
  advantage: boolean; ageMin: number | null; ageSuggest: [number, number] | null; ageMax: number | null; genders: "all" | "women" | "men";
  places: { name: string; radius: number | null; lat: number | null; lng: number | null }[]; cities: string[];
  /** Places left out (Locations › Exclude), e.g. another clinic's doorstep inside a wide circle. */
  excluded?: { name: string; radius: number | null; lat: number | null; lng: number | null }[];
  interests: string[]; behaviors: string[]; audiences: string[]; nearest: string | null;
};
/** Meta's targeting JSON → the parts that matter here. Null if it can't be read. */
export function parseTargeting(raw: string | null | undefined): Targeting | null {
  if (!raw) return null;
  let t: any;
  try { t = JSON.parse(raw); } catch { return null; }
  if (!t || typeof t !== "object") return null;
  const names = (arr: any) => (Array.isArray(arr) ? arr.map((x: any) => String(x?.name ?? "")).filter(Boolean) : []);
  const flex: any[] = Array.isArray(t.flexible_spec) ? t.flexible_spec : [];
  const toPlace = (p: any) => ({ name: String(p?.name ?? ""), radius: p?.radius ?? null, lat: p?.latitude ?? null, lng: p?.longitude ?? null });
  const places = (t.geo_locations?.places ?? []).map(toPlace);
  const excluded = (t.excluded_geo_locations?.places ?? []).map(toPlace);
  const g: number[] = Array.isArray(t.genders) ? t.genders : [];
  const p0 = places.find((p: any) => p.lat !== null && p.lng !== null);
  let nearest: string | null = null;
  if (p0) {
    let best = Infinity;
    for (const [code, [la, lo]] of Object.entries(CLINIC_PIN)) {
      const dd = (la - p0.lat) ** 2 + ((lo - p0.lng) * Math.cos((la * Math.PI) / 180)) ** 2;
      if (dd < best) { best = dd; nearest = code; }
    }
  }
  const ar = Array.isArray(t.age_range) && t.age_range.length === 2 ? ([Number(t.age_range[0]), Number(t.age_range[1])] as [number, number]) : null;
  return {
    advantage: Number(t.targeting_automation?.advantage_audience) === 1,
    ageMin: t.age_min ?? null, ageMax: t.age_max ?? null, ageSuggest: ar,
    genders: g.length === 1 && g[0] === 2 ? "women" : g.length === 1 && g[0] === 1 ? "men" : "all",
    places, cities: names(t.geo_locations?.cities), excluded,
    interests: [...new Set(flex.flatMap((f) => names(f?.interests)))],
    behaviors: [...new Set(flex.flatMap((f) => names(f?.behaviors)))],
    audiences: names(t.custom_audiences), nearest,
  };
}
export function targetingText(t: Targeting): string {
  const parts = [t.advantage ? "Advantage+ audience" : "Detailed targeting (Advantage+ off)"];
  const age = t.ageSuggest ? `ages ${t.ageSuggest[0]}–${t.ageSuggest[1]} suggested (min ${t.ageMin ?? 18})` : `ages ${t.ageMin ?? 18}–${t.ageMax ?? 65}`;
  parts.push(age, t.genders === "all" ? "all genders" : t.genders);
  const geo = [...t.places.map((p) => `${p.radius ?? "?"} mi around ${p.name}`), ...t.cities];
  if (geo.length) parts.push(geo.join(" + "));
  if (t.audiences.length) parts.push(`${t.audiences.length} lookalike/custom audience${t.audiences.length === 1 ? "" : "s"}`);
  if (t.interests.length) parts.push(`${t.interests.length} interests (${t.interests.slice(0, 4).join(", ")}${t.interests.length > 4 ? "…" : ""})`);
  return parts.join(" · ");
}

/**
 * Each running ad's state, from the playbook's refresh_rule (CHRIS Nov 27): judge an ad by its own results, not its age.
 * Baseline = the ad's best 14-day cost per chat* after learning (its first 7 days and 50 chats are skipped).
 *   WINNER: last 7 days within +20% of baseline and at or under the target. Keep it, never edit it.
 *   TIRING: 2 signs: cost per chat 20%+ over baseline, and click rate 25%+ under its best week (frequency and quality
 *           ranking are checked in Ads Manager). Add 1–2 new versions to the ad set; don't pause.
 *   FATIGUED: 35%+ over baseline two weeks running. Pause, launch its remake, rest it 6–8 weeks.
 *   LOSER: after 7 days and ₱3,000*, 50%+ over the target (or ₱1,000* and no chats). Pause; no remake.
 *   NEW: still learning (under 7 days or 50 chats). STEADY: none of these.
 */
export type AdState = "WINNER" | "TIRING" | "FATIGUED" | "LOSER" | "NEW" | "STEADY";
export type AdView = {
  id: string; name: string; adset: string; sid: string; cid: string; status: string; t14: Totals; t7: Totals; p7: Totals; t28: Totals; cpc14: number | null;
  age: number; agePlus: boolean; state: AdState | null; why: string; baseline: number | null;
};
export type AdSetView = {
  id: string; name: string; campaign: string; cid: string; status: string; t7: Totals; p7: Totals; targeting: Targeting | null; text: string | null;
  mismatch: string | null; learnShort: boolean;
  /** Daily budget before VAT (pesos): the ad set's own, or its share of a campaign budget by last week's spend. */
  budget?: number | null; budgetSource?: "adset" | "campaign" | "none";
};
export type Action = "RAISE" | "TEST" | "CUT" | "KEEP" | "WAIT" | "OFF" | "START" | "NONE";
export type LineView = {
  branch: string; service: AdService; key: string;
  budget: number; budgetSource: "adset" | "campaign" | "none"; lastChange: string | null; lockedUntil: string | null;
  t7: Totals; p7: Totals; t28: Totals; sales7: number; salesP7: number; roas7: number | null; roasP7: number | null;
  share: number; salesPerChat: number | null; action: Action; newBudget: number; headline: string; why: string; nextReview: string;
  ads: AdView[]; adsets: AdSetView[];
  /** Last 28 days, oldest first (spend pre-VAT pesos, chats), for sparklines. */
  days: { d: string; sp: number; m: number }[];
  /** ROAS for the last 4 weeks, oldest first (null = no spend that week). */
  roasWeeks: (number | null)[];
};

/** Round a pre-VAT daily budget to ₱50. */
const r50 = (p: number) => Math.max(0, Math.round(p / 50) * 50);

type Budget = { date: string; value: number; changed: string | null };
/** Latest daily budget (pre-VAT pesos) per campaign or ad set, and the last day it changed. */
function budgets(rows: FeedRow[], idOf: (r: FeedRow) => string | null, valOf: (r: FeedRow) => number | null) {
  const by = new Map<string, { d: string; v: number }[]>();
  for (const r of rows) {
    const id = idOf(r), v = valOf(r);
    if (!id || v === null || !(v > 0)) continue;
    const a = by.get(id) ?? [];
    a.push({ d: r.d, v });
    by.set(id, a);
  }
  const out = new Map<string, Budget>();
  for (const [id, a] of by) {
    const days = [...new Map(a.sort((x, y) => x.d.localeCompare(y.d)).map((x) => [x.d, x.v])).entries()];
    let changed: string | null = null;
    for (let i = 1; i < days.length; i++) if (days[i][1] !== days[i - 1][1]) changed = days[i][0];
    const [date, value] = days[days.length - 1];
    out.set(id, { date, value: value / 100, changed });
  }
  return out;
}

/**
 * A branch line in the playbook. proposedChange = a controlled budget test the ads work proposes (e.g. Marikina Hiko +20%
 * for 3 weeks), shown as the move while it waits for CHRIS's OK.
 */
export type PlanEntry = { budget: number; status: string; reviewDays: number; targetCpc?: number | null; proposedChange?: { budget: number; why: string; status?: string } | null };

export type AdvisorInput = {
  feed: Feed;
  today: string;
  /** Declared sales per branch code per day (centavos). */
  sales: Map<string, Map<string, number>>;
  /** Share of each branch's sales per ad line. */
  shares: Map<string, Record<AdService, number>>;
  /** Playbook daily budgets (pre-VAT pesos) per "BRANCH|SERVICE", and status. */
  plan: Map<string, PlanEntry>;
};

const sumSales = (m: Map<string, number> | undefined, from: string, to: string) => {
  let s = 0;
  if (!m) return 0;
  for (const [d, v] of m) if (d >= from && d <= to) s += v;
  return s;
};

export function advise(inp: AdvisorInput) {
  const { feed, today } = inp;
  const rows = feed.rows.filter((r) => PAGES[r.page]);
  const lastDate = feed.last_date ?? rows.reduce((m, r) => (r.d > m ? r.d : m), "");
  // Weeks end on the last full day of data (today's partial row is left out).
  const end = !lastDate ? addDay(today, -1) : lastDate >= today ? addDay(today, -1) : lastDate;
  const w7 = addDay(end, -6), p7a = addDay(end, -13), p7b = addDay(end, -7), w14 = addDay(end, -13), w28 = addDay(end, -27);
  const inR = (d: string, a: string, b: string) => d >= a && d <= b;

  const campB = budgets(rows, (r) => r.cid, (r) => (r.cb === null ? null : n(r.cb)));
  const setB = budgets(rows, (r) => r.sid, (r) => (r.sb === null ? null : n(r.sb)));
  const latestStatus = new Map<string, { d: string; ss: string; as: string; name: string; adset: string; sid: string; cid: string; c: string }>();
  for (const r of rows) {
    const cur = latestStatus.get(r.aid);
    if (!cur || r.d >= cur.d) latestStatus.set(r.aid, { d: r.d, ss: r.ss ?? "", as: r.as ?? "", name: r.a ?? r.aid, adset: r.s ?? "", sid: r.sid ?? "", cid: r.cid ?? "", c: r.c ?? "" });
  }
  const isLive = (aid: string) => {
    const s = latestStatus.get(aid);
    return !!s && s.as === "ACTIVE" && s.d >= addDay(end, -2);
  };

  // Group per line, per ad and per ad set.
  type Acc = { t7: Totals; p7: Totals; t14: Totals; t28: Totals };
  const acc = () => ({ t7: zero(), p7: zero(), t14: zero(), t28: zero() });
  const lines = new Map<string, Acc>();
  const ads = new Map<string, Acc & { key: string; first: string }>();
  const daily = new Map<string, Map<string, { sp: number; m: number; im: number; cl: number }>>();
  const lineDaily = new Map<string, Map<string, { sp: number; m: number }>>();
  const feedStart = rows.reduce((m, r) => (m === "" || r.d < m ? r.d : m), "");
  const sets = new Map<string, Acc & { key: string; name: string; campaign: string; cid: string }>();
  const campSpend7 = new Map<string, Map<string, number>>(); // campaign → line → spend (to split a campaign budget)
  for (const r of rows) {
    const key = `${PAGES[r.page]}|${serviceOfAd(r.c, r.s, r.a)}`;
    const L = lines.get(key) ?? acc(); lines.set(key, L);
    const A = ads.get(r.aid) ?? { ...acc(), key, first: "9999-12-31" }; ads.set(r.aid, A);
    if (n(r.sp) > 0 && r.d < A.first) A.first = r.d;
    const dm = daily.get(r.aid) ?? new Map(); daily.set(r.aid, dm);
    const dd = dm.get(r.d) ?? { sp: 0, m: 0, im: 0, cl: 0 };
    dd.sp += n(r.sp); dd.m += n(r.m); dd.im += n(r.im); dd.cl += n(r.cl); dm.set(r.d, dd);
    const lm = lineDaily.get(key) ?? new Map(); lineDaily.set(key, lm);
    const ld = lm.get(r.d) ?? { sp: 0, m: 0 };
    ld.sp += n(r.sp); ld.m += n(r.m); lm.set(r.d, ld);
    const sid = r.sid ?? `${r.cid}-none`;
    const S = sets.get(sid) ?? { ...acc(), key, name: r.s ?? "", campaign: r.c ?? "", cid: r.cid ?? "" }; sets.set(sid, S);
    for (const X of [L, A, S]) {
      if (inR(r.d, w7, end)) add(X.t7, r);
      if (inR(r.d, p7a, p7b)) add(X.p7, r);
      if (inR(r.d, w14, end)) add(X.t14, r);
      if (inR(r.d, w28, end)) add(X.t28, r);
    }
    if (inR(r.d, w7, end) && r.cid) {
      const m = campSpend7.get(r.cid) ?? new Map<string, number>();
      m.set(key, (m.get(key) ?? 0) + n(r.sp));
      campSpend7.set(r.cid, m);
    }
  }

  // Today's daily budget per line: ad set budgets of live ad sets, plus each live campaign budget split by last week's spend.
  const liveSets = new Set<string>(), liveCamps = new Set<string>();
  for (const [aid, s] of latestStatus) if (isLive(aid)) { if (s.sid) liveSets.add(s.sid); if (s.cid) liveCamps.add(s.cid); }
  const lineBudget = new Map<string, { budget: number; source: "adset" | "campaign" | "none"; changed: string | null }>();
  const bump = (key: string, v: number, src: "adset" | "campaign", changed: string | null) => {
    const cur = lineBudget.get(key) ?? { budget: 0, source: src, changed: null };
    cur.budget += v; cur.source = src;
    if (changed && (!cur.changed || changed > cur.changed)) cur.changed = changed;
    lineBudget.set(key, cur);
  };
  for (const sid of liveSets) {
    const b = setB.get(sid), S = sets.get(sid);
    if (b && S) bump(S.key, b.value, "adset", b.changed);
  }
  for (const cid of liveCamps) {
    const b = campB.get(cid);
    if (!b) continue;
    const split = campSpend7.get(cid);
    const tot = split ? [...split.values()].reduce((a, v) => a + v, 0) : 0;
    if (!split || tot <= 0) continue;
    for (const [key, v] of split) bump(key, (b.value * v) / tot, "campaign", b.changed);
  }

  const keys = new Set<string>([...lines.keys(), ...inp.plan.keys()].filter((k) => BRANCH_ORDER.includes(k.split("|")[0])));
  const out: LineView[] = [];
  for (const key of keys) {
    const [branch, service] = key.split("|") as [string, AdService];
    const L = lines.get(key) ?? acc();
    const plan = inp.plan.get(key);
    const share = inp.shares.get(branch)?.[service] ?? 0;
    const sales7 = Math.round(sumSales(inp.sales.get(branch), w7, end) * share);
    const salesP7 = Math.round(sumSales(inp.sales.get(branch), p7a, p7b) * share);
    // ROAS = the line's share of branch sales ÷ spend with VAT (sales in centavos, spend in pesos).
    const roas7 = L.t7.spend > 0 ? sales7 / 100 / (L.t7.spend * 1.12) : null;
    const roasP7 = L.p7.spend > 0 ? salesP7 / 100 / (L.p7.spend * 1.12) : null;
    const lb = lineBudget.get(key);
    const budget = lb ? r50(lb.budget) : 0;
    const lockedUntil = lb?.changed && addDay(lb.changed, LOCK_DAYS) > today ? addDay(lb.changed, LOCK_DAYS) : null;
    const target = plan?.budget ?? null;

    let action: Action = "KEEP", newBudget = budget, why = "";
    const live = budget > 0;
    if (!live) {
      if (plan && plan.budget > 0 && plan.status !== "off") { action = "START"; newBudget = plan.budget; why = `No live ad set. The plan starts it at ₱${plan.budget.toLocaleString("en-US")}/day.`; }
      else { action = "NONE"; newBudget = 0; why = plan?.status === "off" ? "Off on purpose (low return). Test new creative in the testing ad set first." : "No ads running."; }
    } else if (plan?.status === "off") {
      action = "OFF"; newBudget = 0; why = "The plan keeps this line off; its return is too low.";
    } else if (lockedUntil) {
      action = "WAIT"; why = `Budget changed on ${fmtDay(lb!.changed!)}. Leave it until ${fmtDay(lockedUntil)} so Meta's learning isn't reset.`;
    } else if (plan?.proposedChange && plan.proposedChange.budget > 0 && !(roas7 !== null && roasP7 !== null && roas7 < CUT_BELOW && roasP7 < CUT_BELOW)) {
      // A controlled test from the playbook wins over the plain rules (one branch at a time, so its effect can be measured).
      action = "TEST"; newBudget = r50(plan.proposedChange.budget);
      why = `${plan.proposedChange.why}${plan.proposedChange.status === "proposed" ? " Waiting for your OK." : ""}`;
    } else if (roas7 !== null && roasP7 !== null && roas7 >= RAISE_AT && roasP7 >= RAISE_AT) {
      if (plan) {
        // Nov 27 growth check (45 weeks, every branch): extra spend on the same ads returned only about 0.5–1.8x.
        action = "KEEP";
        why = `ROAS ${roas7.toFixed(1)}x this week and ${roasP7.toFixed(1)}x last week, but in 2026 more spend on the same ads didn't bring more sales. Put extra money into a new offer instead (see New ad sets).`;
      } else {
        action = "RAISE"; newBudget = r50(budget * (1 + STEP)); why = `ROAS ${roas7.toFixed(1)}x this week and ${roasP7.toFixed(1)}x last week, both ${RAISE_AT}x or more.`;
      }
    } else if (roas7 !== null && roasP7 !== null && roas7 < CUT_BELOW && roasP7 < CUT_BELOW) {
      action = "CUT"; newBudget = r50(budget * (1 - STEP)); why = `ROAS under ${CUT_BELOW}x two weeks running (${roas7.toFixed(1)}x, ${roasP7.toFixed(1)}x).`;
    } else if (target !== null && budget > target * 1.2 && !(roas7 !== null && roas7 >= RAISE_AT)) {
      action = "CUT"; newBudget = Math.max(r50(target), r50(budget * (1 - STEP))); why = `Above the plan (₱${target.toLocaleString("en-US")}/day) without a ${RAISE_AT}x week. Step down 20% at a time.`;
    } else if (target !== null && budget < target * 0.8 && roas7 !== null && roas7 >= 4) {
      action = "RAISE"; newBudget = Math.min(r50(target), r50(budget * (1 + STEP))); why = `Under the plan (₱${target.toLocaleString("en-US")}/day) and returning ${roas7.toFixed(1)}x. Step up 20%.`;
    } else {
      why = roas7 === null ? "Not enough spend this week to judge."
        : roas7 < CUT_BELOW ? `ROAS ${roas7.toFixed(1)}x this week, under ${CUT_BELOW}x for the first week. Cut 20% if next week stays under.`
        : roas7 >= RAISE_AT ? `ROAS ${roas7.toFixed(1)}x this week, ${RAISE_AT}x+ for the first week. Raise 20% if next week holds.`
        : `ROAS ${roas7.toFixed(1)}x this week: between ${CUT_BELOW}x and ${RAISE_AT}x, so hold.`;
    }

    // Ads in this line, judged by their own results (playbook refresh_rule), not their age.
    const lineCpc = perChat(L.t14);
    const targetCpc = plan?.targetCpc ?? lineCpc ?? null;
    const adViews: AdView[] = [];
    for (const [aid, A] of ads) {
      if (A.key !== key) continue;
      const s = latestStatus.get(aid)!;
      const live = isLive(aid), cpc14 = perChat(A.t14);
      const age = A.first > end ? 0 : daysBetween(A.first, end) + 1, agePlus = A.first <= addDay(feedStart, 7);
      const j = judgeAd(daily.get(aid) ?? new Map(), A.first, end, agePlus, targetCpc);
      let state: AdState | null = live ? j.state : null, why = live ? j.why : "";
      if (live && A.t14.spend * 1.12 >= 1000 && A.t14.msgs === 0) { state = "LOSER"; why = `₱${Math.round(A.t14.spend * 1.12).toLocaleString("en-US")}* in 14 days and no chats. Pause it.`; }
      if (!live && A.t14.spend === 0) continue;
      adViews.push({ id: aid, name: s.name, adset: s.adset, sid: s.sid, cid: s.cid, status: live ? "ACTIVE" : s.as || s.ss || "OFF", t14: A.t14, t7: A.t7, p7: A.p7, t28: A.t28, cpc14, age, agePlus, state, why, baseline: j.baseline });
    }
    adViews.sort((a, b) => b.t14.spend - a.t14.spend);

    // Ad sets in this line with their targeting.
    const setViews: AdSetView[] = [];
    for (const [sid, S] of sets) {
      if (S.key !== key || !liveSets.has(sid)) continue;
      const tg = parseTargeting(feed.targeting[sid]);
      const mismatch = tg?.nearest && tg.nearest !== branch ? tg.nearest : null;
      const own = setB.get(sid), camp = S.cid ? campB.get(S.cid) : undefined;
      let budget: number | null = null, budgetSource: "adset" | "campaign" | "none" = "none";
      if (own) { budget = own.value; budgetSource = "adset"; }
      else if (camp) {
        const peers = [...sets].filter(([id, X]) => X.cid === S.cid && liveSets.has(id) && !setB.get(id));
        const tot = peers.reduce((a, [, X]) => a + X.t7.spend, 0);
        budget = peers.length === 1 ? camp.value : tot > 0 ? (camp.value * S.t7.spend) / tot : camp.value / Math.max(1, peers.length);
        budgetSource = "campaign";
      }
      setViews.push({ id: sid, name: S.name, campaign: S.campaign, cid: S.cid, status: "ACTIVE", t7: S.t7, p7: S.p7, targeting: tg, text: tg ? targetingText(tg) : null, mismatch, learnShort: S.t7.msgs < LEARN_PER_WEEK, budget, budgetSource });
    }
    setViews.sort((a, b) => b.t7.spend - a.t7.spend);

    const lm = lineDaily.get(key);
    const days = Array.from({ length: 28 }, (_, i) => { const d = addDay(w28, i), x = lm?.get(d); return { d, sp: x?.sp ?? 0, m: x?.m ?? 0 }; });
    const roasWeeks = [3, 2, 1, 0].map((k) => {
      const b = addDay(end, -7 * k), a = addDay(b, -6);
      const sp = days.filter((x) => x.d >= a && x.d <= b).reduce((t, x) => t + x.sp, 0);
      return sp > 0 ? (sumSales(inp.sales.get(branch), a, b) * share) / 100 / (sp * 1.12) : null;
    });

    const reviewDays = Math.max(LOCK_DAYS, plan?.reviewDays ?? LOCK_DAYS);
    const nextReview = lockedUntil ?? (lb?.changed && daysBetween(lb.changed, today) < reviewDays ? addDay(lb.changed, reviewDays) : today);
    out.push({
      branch, service, key, budget, budgetSource: lb?.source ?? "none", lastChange: lb?.changed ?? null, lockedUntil,
      t7: L.t7, p7: L.p7, t28: L.t28, sales7, salesP7, roas7, roasP7, share, salesPerChat: L.t7.msgs > 0 ? sales7 / 100 / L.t7.msgs : null, action, newBudget, headline: headlineOf(action, budget, newBudget), why, nextReview,
      ads: adViews, adsets: setViews, days, roasWeeks,
    });
  }
  out.sort((a, b) => BRANCH_ORDER.indexOf(a.branch) - BRANCH_ORDER.indexOf(b.branch) || b.share - a.share);
  return { lines: out, end, w7, lastDate: lastDate || null, staleDays: lastDate ? daysBetween(lastDate, today) : null };
}

type Day = { sp: number; m: number; im: number; cl: number };
const sumDays = (dm: Map<string, Day>, a: string, b: string) => {
  const t = { sp: 0, m: 0, im: 0, cl: 0 };
  for (const [d, v] of dm) if (d >= a && d <= b) { t.sp += v.sp; t.m += v.m; t.im += v.im; t.cl += v.cl; }
  return t;
};
const cpcOf = (t: Day, minChats = 1) => (t.m >= minChats ? (t.sp * 1.12) / t.m : null);

/** One ad's state from its daily rows (see AdState). target = the ad set's target cost per chat*, if known. */
export function judgeAd(dm: Map<string, Day>, first: string, end: string, olderThanFeed: boolean, target: number | null): { state: AdState; why: string; baseline: number | null } {
  // Learning ends 7 days in and after 50 chats (ads that started before the feed are long past it).
  let learnEnd = first;
  if (!olderThanFeed) {
    let chats = 0;
    learnEnd = addDay(first, 6);
    for (const d of [...dm.keys()].sort()) { chats += dm.get(d)!.m; if (chats >= 50) { if (d > learnEnd) learnEnd = d; break; } }
    if (chats < 50) learnEnd = "9999-12-31";
  }
  const total = sumDays(dm, first, end);
  const age = first > end ? 0 : daysBetween(first, end) + 1;
  const c7 = cpcOf(sumDays(dm, addDay(end, -6), end), 10), cP7 = cpcOf(sumDays(dm, addDay(end, -13), addDay(end, -7)), 10);
  const c14 = cpcOf(sumDays(dm, addDay(end, -13), end), 10);
  const fmt = (v: number) => `₱${v.toFixed(0)}*`;
  if (learnEnd >= end) {
    if (age >= 7 && total.sp * 1.12 >= 3000 && target && c14 !== null && c14 >= target * 1.5)
      return { state: "LOSER", why: `After ${age} days and ₱${Math.round(total.sp * 1.12).toLocaleString("en-US")}*: ${fmt(c14)} a chat, 50%+ over the ${fmt(target)} target. Pause it; no remake, learn from its hook.`, baseline: null };
    return { state: "NEW", why: `Still learning (${age} day${age === 1 ? "" : "s"}, ${total.m} chats): judge it after 7 days and 50 chats.`, baseline: null };
  }
  // Baseline: best 14-day cost per chat after learning; with under 14 days since, the whole period after learning.
  const start = addDay(learnEnd, 1) > first && !olderThanFeed ? addDay(learnEnd, 1) : first;
  let baseline: number | null = null, peakCtr: number | null = null;
  for (let e = addDay(start, 13); e <= end; e = addDay(e, 1)) {
    const c = cpcOf(sumDays(dm, addDay(e, -13), e), 20);
    if (c !== null && (baseline === null || c < baseline)) baseline = c;
  }
  if (baseline === null) baseline = cpcOf(sumDays(dm, start, end), 20);
  for (let e = addDay(start, 6); e <= end; e = addDay(e, 1)) {
    const w = sumDays(dm, addDay(e, -6), e);
    if (w.im >= 5000 && (peakCtr === null || w.cl / w.im > peakCtr)) peakCtr = w.cl / w.im;
  }
  const last = sumDays(dm, addDay(end, -6), end);
  const ctr7 = last.im >= 5000 ? last.cl / last.im : null;
  if (baseline === null || c7 === null) return { state: "STEADY", why: "Too few chats this week to judge.", baseline };
  const over = c7 / baseline - 1, run = `${age}${olderThanFeed ? "+" : ""} days`;
  if (cP7 !== null && c7 > baseline * 1.35 && cP7 > baseline * 1.35)
    return { state: "FATIGUED", why: `${fmt(c7)} a chat, ${Math.round(over * 100)}% over its best (${fmt(baseline)}) two weeks running. Pause it, launch its remake, and rest it 6–8 weeks.`, baseline };
  if (target && c14 !== null && c14 >= target * 1.5 && baseline >= target * 1.5 && total.sp * 1.12 >= 3000)
    return { state: "LOSER", why: `${fmt(c14)} a chat, 50%+ over the ${fmt(target)} target, and it was never under it. Pause it; no remake.`, baseline };
  const signs = [c7 > baseline * 1.2 ? `cost per chat +${Math.round(over * 100)}% over its best` : "", ctr7 !== null && peakCtr !== null && ctr7 < peakCtr * 0.75 ? `click rate ${Math.round((1 - ctr7 / peakCtr) * 100)}% under its best week` : ""].filter(Boolean);
  if (signs.length >= 2) return { state: "TIRING", why: `Tiring: ${signs.join(" and ")}. Don't pause yet: add 1–2 new versions to the ad set (new first 3 seconds, hook or person, same message).`, baseline };
  if (c7 <= baseline * 1.2 && (!target || c7 <= target))
    return { state: "WINNER", why: `${fmt(c7)} a chat this week vs its best ${fmt(baseline)} after ${run}. Keep it and its budget; never edit it (duplicate it to try a change).`, baseline };
  return { state: "STEADY", why: `${fmt(c7)} a chat this week (best ${fmt(baseline)}${target ? `, target ${fmt(target)}` : ""})${signs.length ? `; ${signs[0]}` : ""}. Keep it while it holds and test new concepts beside it.`, baseline };
}

const peso = (p: number) => `₱${Math.round(p).toLocaleString("en-US")}`;
export function headlineOf(a: Action, budget: number, next: number) {
  switch (a) {
    case "RAISE": return `Raise to ${peso(next)}/day (from ${peso(budget)})`;
    case "TEST": return `Test ${peso(next)}/day for 3 weeks (from ${peso(budget)})`;
    case "CUT": return `Cut to ${peso(next)}/day (from ${peso(budget)})`;
    case "WAIT": return `Keep ${peso(budget)}/day for now`;
    case "OFF": return `Turn off (${peso(budget)}/day now)`;
    case "START": return `Start at ${peso(next)}/day`;
    case "NONE": return "Off";
    default: return `Keep ${peso(budget)}/day`;
  }
}
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const fmtDay = (d: string) => `${MON[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;

/** "Main driver", "Second" … by the line's share of the branch's sales. */
export function roleOf(rank: number, share: number) {
  if (rank === 0 && share >= 0.4) return "main sales driver";
  if (rank === 0) return "biggest ad line";
  if (rank === 1) return "second";
  return "smaller line";
}
