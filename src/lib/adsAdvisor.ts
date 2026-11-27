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
const CLINIC_PIN: Record<string, [number, number]> = {
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
  const places = (t.geo_locations?.places ?? []).map((p: any) => ({ name: String(p?.name ?? ""), radius: p?.radius ?? null, lat: p?.latitude ?? null, lng: p?.longitude ?? null }));
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
    places, cities: names(t.geo_locations?.cities),
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

export type AdFlag = "OFF" | "WINNER" | "TIRING" | null;
export type AdView = {
  id: string; name: string; adset: string; status: string; t14: Totals; t7: Totals; p7: Totals; cpc14: number | null; flag: AdFlag; why: string;
};
export type AdSetView = {
  id: string; name: string; campaign: string; status: string; t7: Totals; targeting: Targeting | null; text: string | null;
  mismatch: string | null; learnShort: boolean;
};
export type Action = "RAISE" | "TEST" | "CUT" | "KEEP" | "WAIT" | "OFF" | "START" | "NONE";
export type LineView = {
  branch: string; service: AdService; key: string;
  budget: number; budgetSource: "adset" | "campaign" | "none"; lastChange: string | null; lockedUntil: string | null;
  t7: Totals; p7: Totals; t28: Totals; sales7: number; salesP7: number; roas7: number | null; roasP7: number | null;
  share: number; action: Action; newBudget: number; headline: string; why: string; nextReview: string;
  ads: AdView[]; adsets: AdSetView[];
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
export type PlanEntry = { budget: number; status: string; reviewDays: number; proposedChange?: { budget: number; why: string; status?: string } | null };

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
  const ads = new Map<string, Acc & { key: string }>();
  const sets = new Map<string, Acc & { key: string; name: string; campaign: string }>();
  const campSpend7 = new Map<string, Map<string, number>>(); // campaign → line → spend (to split a campaign budget)
  for (const r of rows) {
    const key = `${PAGES[r.page]}|${serviceOfAd(r.c, r.s, r.a)}`;
    const L = lines.get(key) ?? acc(); lines.set(key, L);
    const A = ads.get(r.aid) ?? { ...acc(), key }; ads.set(r.aid, A);
    const sid = r.sid ?? `${r.cid}-none`;
    const S = sets.get(sid) ?? { ...acc(), key, name: r.s ?? "", campaign: r.c ?? "" }; sets.set(sid, S);
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

    // Ads in this line.
    const lineCpc = perChat(L.t14);
    const adViews: AdView[] = [];
    for (const [aid, A] of ads) {
      if (A.key !== key) continue;
      const s = latestStatus.get(aid)!;
      const cpc14 = perChat(A.t14), live = isLive(aid);
      let flag: AdFlag = null, w = "";
      if (live && A.t14.spend * 1.12 >= 1000 && A.t14.msgs === 0) { flag = "OFF"; w = `₱${Math.round(A.t14.spend * 1.12).toLocaleString("en-US")}* in 14 days and no chats.`; }
      else if (live && cpc14 !== null && lineCpc !== null && A.t14.spend * 1.12 >= 1500 && cpc14 >= lineCpc * 1.6) { flag = "OFF"; w = `₱${cpc14.toFixed(0)}* a chat, ${(cpc14 / lineCpc).toFixed(1)}× this line's ₱${lineCpc.toFixed(0)}*.`; }
      else if (A.t14.msgs >= 30 && cpc14 !== null && lineCpc !== null && cpc14 <= lineCpc * 0.8) { flag = "WINNER"; w = `₱${cpc14.toFixed(0)}* a chat on ${A.t14.msgs} chats, ${Math.round((1 - cpc14 / lineCpc) * 100)}% cheaper than this line. Make 2–3 new versions of it.`; }
      else if (live) {
        const c7 = perChat(A.t7), cp = perChat(A.p7), r7 = ctr(A.t7), rp = ctr(A.p7);
        if (c7 !== null && cp !== null && A.t7.msgs >= 15 && A.p7.msgs >= 15 && c7 > cp * 1.3) { flag = "TIRING"; w = `Cost per chat up ${Math.round((c7 / cp - 1) * 100)}% on last week (₱${cp.toFixed(0)}* → ₱${c7.toFixed(0)}*). Line up a fresh version.`; }
        else if (r7 !== null && rp !== null && A.t7.impressions >= 5000 && A.p7.impressions >= 5000 && r7 < rp * 0.7) { flag = "TIRING"; w = `Click rate down ${Math.round((1 - r7 / rp) * 100)}% on last week. Line up a fresh version.`; }
      }
      if (!live && A.t14.spend === 0 && flag !== "WINNER") continue;
      adViews.push({ id: aid, name: s.name, adset: s.adset, status: live ? "ACTIVE" : s.as || s.ss || "OFF", t14: A.t14, t7: A.t7, p7: A.p7, cpc14, flag, why: w });
    }
    adViews.sort((a, b) => b.t14.spend - a.t14.spend);

    // Ad sets in this line with their targeting.
    const setViews: AdSetView[] = [];
    for (const [sid, S] of sets) {
      if (S.key !== key || !liveSets.has(sid)) continue;
      const tg = parseTargeting(feed.targeting[sid]);
      const mismatch = tg?.nearest && tg.nearest !== branch ? tg.nearest : null;
      setViews.push({ id: sid, name: S.name, campaign: S.campaign, status: "ACTIVE", t7: S.t7, targeting: tg, text: tg ? targetingText(tg) : null, mismatch, learnShort: S.t7.msgs < LEARN_PER_WEEK });
    }
    setViews.sort((a, b) => b.t7.spend - a.t7.spend);

    const reviewDays = Math.max(LOCK_DAYS, plan?.reviewDays ?? LOCK_DAYS);
    const nextReview = lockedUntil ?? (lb?.changed && daysBetween(lb.changed, today) < reviewDays ? addDay(lb.changed, reviewDays) : today);
    out.push({
      branch, service, key, budget, budgetSource: lb?.source ?? "none", lastChange: lb?.changed ?? null, lockedUntil,
      t7: L.t7, p7: L.p7, t28: L.t28, sales7, salesP7, roas7, roasP7, share, action, newBudget, headline: headlineOf(action, budget, newBudget), why, nextReview,
      ads: adViews, adsets: setViews,
    });
  }
  out.sort((a, b) => BRANCH_ORDER.indexOf(a.branch) - BRANCH_ORDER.indexOf(b.branch) || b.share - a.share);
  return { lines: out, end, w7, lastDate: lastDate || null, staleDays: lastDate ? daysBetween(lastDate, today) : null };
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
