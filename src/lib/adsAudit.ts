/**
 * Ad advisor checks (v0.99.6, CHRIS Nov 28: "Apply such rigorous assessments of ads in all relevant data points we have").
 * Every check reads only data we have (the daily Meta feed with each ad set's targeting, declared daily sales and the
 * playbook) and points at the one ad, ad set or page to open. Spend is VAT-inclusive (*), budgets are before VAT.
 */
import { addDay, CLINIC_PIN, LEARN_PER_WEEK, PAGES, perChat, type AdSetView, type Feed, type LineView } from "./adsAdvisor";
import { SERVICE_LABEL } from "./ads";

export type CheckKey = "pin" | "overlap" | "age" | "gender" | "split" | "setCost" | "dupe" | "zeroDay" | "cpcJump" | "quality" | "saturation";
/** Every check, in the order it is listed on the page. */
export const CHECKS: { key: CheckKey; label: string }[] = [
  { key: "pin", label: "Each ad set's pin is in its own branch's area" },
  { key: "overlap", label: "Branch circles don't reach another clinic" },
  { key: "age", label: "Ages 21+ (house rule)" },
  { key: "gender", label: "Gender matches the plan" },
  { key: "split", label: "Ad sets get enough chats to leave learning" },
  { key: "setCost", label: "Ad sets in a line cost about the same per chat" },
  { key: "dupe", label: "No ad runs in two ad sets of the same line" },
  { key: "zeroDay", label: "No ad money on days a branch declared ₱0 sales" },
  { key: "cpcJump", label: "Cost per chat steady week to week" },
  { key: "quality", label: "Sales per chat holding as chats change" },
  { key: "saturation", label: "Audiences not wearing out (frequency and clicks)" },
];

/** Where the action happens: an object in Ads Manager, or a page. */
export type Target =
  | { kind: "campaign" | "adset" | "ad"; id: string; cid: string; view?: "edit" | "list" | "ads" }
  | { kind: "page"; href: string; external?: boolean };
export type Finding = {
  id: string; check: CheckKey; sev: "bad" | "warn" | "info"; line: string | null; tag: string;
  /** The ad set's name, on setting fixes. */
  name?: string;
  title: string; short: string; why: string; action: string; target: Target | null; approve: string;
};

const SHORT: Record<string, string> = { QC_MAIN: "QC Main", FAIRVIEW: "Fairview", STA_MARIA: "Sta. Maria", MARIKINA: "Marikina" };
const n = (v: unknown) => (v === null || v === undefined || v === "" ? 0 : Number(v) || 0);
const peso = (p: number) => `₱${Math.round(p).toLocaleString("en-US")}`;
const pct = (x: number) => `${Math.round(Math.abs(x) * 100)}%`;
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (d: string) => `${DOW[new Date(`${d}T00:00:00Z`).getUTCDay()]} ${MON[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;
/** Miles between two points (good enough at city scale). */
export const miles = (a: [number, number], b: [number, number]) => {
  const k = Math.cos(((a[0] + b[0]) / 2) * (Math.PI / 180));
  return Math.hypot(a[0] - b[0], (a[1] - b[1]) * k) * 69.05;
};

export type AuditInput = {
  feed: Feed;
  lines: LineView[];
  end: string;
  /** Declared sales per branch per day (centavos); a typed ₱0 day is 0, an untyped day is missing. */
  sales: Map<string, Map<string, number>>;
  /** Playbook audience per "BRANCH|SERVICE" (genders "all" | "female" | …, age_min). */
  plan: (branch: string, service: string) => { genders: string; ageMin: number } | null;
};

export function audit(inp: AuditInput): Finding[] {
  const { feed, lines, end, sales } = inp;
  const out: Finding[] = [];
  const tagOf = (l: LineView) => `${SHORT[l.branch] ?? l.branch} · ${SERVICE_LABEL[l.service]}`;
  const w7 = addDay(end, -6), w21a = addDay(end, -20), w21b = addDay(end, -14), w28 = addDay(end, -27);
  const sets = lines.flatMap((l) => l.adsets.map((s) => ({ l, s })));

  // 1. Pin in the wrong branch's area.
  for (const { l, s } of sets) {
    if (!s.mismatch) continue;
    out.push({
      id: `pin-${s.id}`, name: s.name, check: "pin", sev: "bad", line: l.key, tag: tagOf(l), title: `Move the map pin to ${SHORT[l.branch]}`,
      short: `"${s.name}" is aimed at the ${SHORT[s.mismatch] ?? s.mismatch} area`,
      why: `This ad set runs on the ${SHORT[l.branch]} page, but its location pin is nearest the ${SHORT[s.mismatch] ?? s.mismatch} clinic, so its chats come from people closer to another branch. In the ad set, open Audience › Locations and move the pin (and radius) to ${SHORT[l.branch]}. ${s.text ?? ""}`,
      action: "Fix location", target: { kind: "adset", id: s.id, cid: s.cid, view: "edit" },
      approve: `${tagOf(l)}: move ad set "${s.name}" pin to ${SHORT[l.branch]}`,
    });
  }

  // 2. A branch's circle reaches another clinic, so two branches bid for the same people.
  for (const { l, s } of sets) {
    if (s.mismatch) continue;
    for (const p of s.targeting?.places ?? []) {
      if (p.lat === null || p.lng === null || !p.radius) continue;
      for (const [code, pin] of Object.entries(CLINIC_PIN)) {
        if (code === l.branch) continue;
        const d = miles([p.lat, p.lng], pin);
        if (d >= p.radius) continue;
        const fix = Math.max(2, Math.floor(d - 0.5));
        out.push({
          id: `overlap-${s.id}-${code}`, name: s.name, check: "overlap", sev: "warn", line: l.key, tag: tagOf(l), title: `Shrink the circle to ${fix} mi`,
          short: `Its ${p.radius}-mile circle covers the ${SHORT[code]} clinic (${d.toFixed(1)} mi away)`,
          why: `"${s.name}" reaches ${p.radius} miles around ${p.name}; the ${SHORT[code]} clinic is ${d.toFixed(1)} miles away, so people near ${SHORT[code]} get ${SHORT[l.branch]} ads and chat with the farther clinic. Where our ad sets reach the same people, Meta enters only one of them in each auction and holds the others back (auction overlap), which slows their learning. Set the radius to about ${fix} miles so it stops short of ${SHORT[code]}, or keep it and exclude a 2-mile circle around the ${SHORT[code]} clinic.`,
          action: "Fix radius", target: { kind: "adset", id: s.id, cid: s.cid, view: "edit" },
          approve: `${tagOf(l)}: set ad set "${s.name}" radius to ${fix} mi`,
        });
        break;
      }
    }
  }

  // 3–4. Ages under 21; gender not what the plan says.
  for (const { l, s } of sets) {
    const t = s.targeting;
    if (!t) continue;
    const plan = inp.plan(l.branch, l.service);
    const minAge = plan?.ageMin && plan.ageMin > 21 ? plan.ageMin : 21;
    if ((t.ageMin ?? 18) < 21) {
      out.push({
        id: `age-${s.id}`, name: s.name, check: "age", sev: "warn", line: l.key, tag: tagOf(l), title: `Raise the minimum age to ${minAge}`,
        short: `"${s.name}" reaches people from age ${t.ageMin ?? 18}`,
        why: `The house rule is 21+ for aesthetic ads (Meta's own floor for cosmetic procedures is 18). Under-21s rarely book and some need a parent's OK. In the ad set's Audience, set the minimum age to ${minAge}${t.advantage ? " (with Advantage+ audience, the minimum age is a hard limit; the age range is only a suggestion)" : ""}.`,
        action: "Fix ages", target: { kind: "adset", id: s.id, cid: s.cid, view: "edit" },
        approve: `${tagOf(l)}: set ad set "${s.name}" minimum age to ${minAge}`,
      });
    }
    if (plan && plan.genders === "all" && t.genders !== "all") {
      out.push({
        id: `gender-${s.id}`, name: s.name, check: "gender", sev: "info", line: l.key, tag: tagOf(l), title: `Open it to all genders`,
        short: `"${s.name}" shows only to ${t.genders}; the plan says all`,
        why: `The playbook audience for ${tagOf(l)} is all genders (men book Hiko and jaw treatments too). Keep it ${t.genders}-only only if it is a deliberate test.`,
        action: "Fix audience", target: { kind: "adset", id: s.id, cid: s.cid, view: "edit" },
        approve: `${tagOf(l)}: set ad set "${s.name}" to all genders`,
      });
    }
  }

  for (const l of lines) {
    const live = l.adsets;
    // 5. Too many ad sets for the chats: each under the learning bar, together over it.
    if (live.length >= 2) {
      const tot = live.reduce((a, s) => a + s.t7.msgs, 0);
      if (live.every((s) => s.t7.msgs < LEARN_PER_WEEK) && tot >= LEARN_PER_WEEK) {
        out.push({
          id: `split-${l.key}`, check: "split", sev: "warn", line: l.key, tag: tagOf(l), title: `Merge ${live.length} ad sets into one`,
          short: `${live.map((s) => s.t7.msgs).join(" + ")} chats a week: none leaves learning`,
          why: `Meta needs about ${LEARN_PER_WEEK} chats a week per ad set to finish learning. Together these ad sets get ${tot}, but split ${live.length} ways none gets there, so all of them stay in learning and cost more. Keep the best one (${live.slice().sort((a, b) => (perChat(a.t7) ?? 1e9) - (perChat(b.t7) ?? 1e9))[0].name}), move its ads and the budget there.`,
          action: "Open ad sets", target: { kind: "adset", id: live[0].id, cid: live[0].cid, view: "list" },
          approve: `${tagOf(l)}: merge ${live.map((s) => `"${s.name}"`).join(", ")} into one ad set`,
        });
      }
      // 6. One ad set costs far more per chat than its sibling.
      const ranked = live.filter((s) => s.t7.msgs >= 20).map((s) => ({ s, c: perChat(s.t7)! })).sort((a, b) => a.c - b.c);
      if (ranked.length >= 2) {
        const best = ranked[0], worst = ranked[ranked.length - 1];
        if (worst.c >= best.c * 1.3) {
          out.push({
            id: `setcost-${worst.s.id}`, check: "setCost", sev: "warn", line: l.key, tag: tagOf(l), title: `Shift budget to "${best.s.name}"`,
            short: `₱${worst.c.toFixed(0)}* a chat vs ₱${best.c.toFixed(0)}* in the other ad set`,
            why: `In the last 7 days "${worst.s.name}" paid ₱${worst.c.toFixed(0)}* a chat (${worst.s.t7.msgs} chats) and "${best.s.name}" ₱${best.c.toFixed(0)}* (${best.s.t7.msgs} chats), ${pct(worst.c / best.c - 1)} more for the same service and branch. Move about 20% of the dearer one's budget to the cheaper one; check sales per chat before moving more. ${worst.s.text ? `Dearer ad set: ${worst.s.text}.` : ""}`,
            action: "Open ad set", target: { kind: "adset", id: worst.s.id, cid: worst.s.cid, view: "edit" },
            approve: `${tagOf(l)}: move 20% of "${worst.s.name}" budget to "${best.s.name}"`,
          });
        }
      }
    }
    // 7. The same ad live in two ad sets of one line competes with itself.
    const byName = new Map<string, typeof l.ads>();
    for (const a of l.ads.filter((x) => x.status === "ACTIVE")) byName.set(a.name.trim().toLowerCase(), [...(byName.get(a.name.trim().toLowerCase()) ?? []), a]);
    for (const [, as] of byName) {
      const setsOf = new Set(as.map((a) => a.sid));
      if (setsOf.size < 2) continue;
      const ranked = as.slice().sort((a, b) => (a.cpc14 ?? 1e9) - (b.cpc14 ?? 1e9));
      const worse = ranked[ranked.length - 1];
      out.push({
        id: `dupe-${worse.id}`, check: "dupe", sev: "info", line: l.key, tag: tagOf(l), title: `Pause the weaker copy of "${worse.name}"`,
        short: `Runs in ${setsOf.size} ad sets of the same line`,
        why: `The same ad runs in ${setsOf.size} ad sets aimed at the same people. Meta lets only one of our ad sets into each auction for a person, so the copies hold each other back and split the chats each needs to finish learning. Keep the copy at ₱${(ranked[0].cpc14 ?? 0).toFixed(0)}* a chat and pause the one at ₱${(worse.cpc14 ?? 0).toFixed(0)}*.`,
        action: "Open ad", target: { kind: "ad", id: worse.id, cid: worse.cid, view: "list" },
        approve: `${tagOf(l)}: pause the copy of ad "${worse.name}" in ad set "${worse.adset}"`,
      });
    }
    // 9. Cost per chat jumped.
    const c7 = perChat(l.t7), cP = perChat(l.p7);
    if (c7 !== null && cP !== null && l.t7.msgs >= LEARN_PER_WEEK && c7 >= cP * 1.3) {
      const top = l.adsets[0];
      out.push({
        id: `cpc-${l.key}`, check: "cpcJump", sev: "warn", line: l.key, tag: tagOf(l), title: `Cost per chat up ${pct(c7 / cP - 1)}`,
        short: `₱${c7.toFixed(0)}* a chat this week vs ₱${cP.toFixed(0)}* last week`,
        why: `Chats got ${pct(c7 / cP - 1)} dearer in one week. Look at the ads list for the one that slipped (it will show as tiring or fatigued) and at the ad set's delivery; don't raise the budget until it settles.`,
        action: top ? "Open ads" : "Open line", target: top ? { kind: "adset", id: top.id, cid: top.cid, view: "ads" } : null,
        approve: `${tagOf(l)}: check why cost per chat rose to ₱${c7.toFixed(0)}*`,
      });
    }
  }

  // 10. More chats, fewer sales per chat, per branch (sales are per branch): a closing problem, not an ads problem.
  //     Only when every day of both weeks has its sales typed in, so a late entry can't look like a drop.
  for (const b of new Set(lines.map((l) => l.branch))) {
    const ls = lines.filter((l) => l.branch === b), s = sales.get(b);
    if (!s) continue;
    const full = (a: string) => Array.from({ length: 7 }, (_, i) => addDay(a, i)).every((d) => s.has(d));
    if (!full(w7) || !full(addDay(w7, -7))) continue;
    const m7 = ls.reduce((x, l) => x + l.t7.msgs, 0), mP = ls.reduce((x, l) => x + l.p7.msgs, 0);
    const s7 = ls.reduce((x, l) => x + l.sales7, 0) / 100, sP = ls.reduce((x, l) => x + l.salesP7, 0) / 100;
    if (m7 < LEARN_PER_WEEK || mP <= 0 || sP <= 0) continue;
    const q7 = s7 / m7, qP = sP / mP;
    if (q7 > qP * 0.75) continue;
    out.push({
      id: `quality-${b}`, check: "quality", sev: "warn", line: null, tag: SHORT[b] ?? b, title: `Each chat is selling ${pct(q7 / qP - 1)} less`,
      short: `${peso(q7)} in sales per chat vs ${peso(qP)} last week (${m7} chats vs ${mP})`,
      why: `${SHORT[b]} got ${m7} ad chats this week (${mP} last week) but each brought ${peso(q7)} in declared sales instead of ${peso(qP)}. In 2026 more chats haven't meant more sales, so check the replies first: how fast CSRs answer, whether they ask for the booking, and the price objections in the inbox. Then check whether a new ad is bringing price-shoppers.`,
      action: "Open inbox", target: { kind: "page", href: "https://business.facebook.com/latest/inbox/all", external: true },
      approve: `${SHORT[b]}: review chats and closing (sales per chat fell to ${peso(q7)})`,
    });
  }

  // 8. Ad money on days a branch declared ₱0 sales (closed, short-staffed or not typed in).
  const spendByBranchDay = new Map<string, Map<string, number>>();
  for (const r of feed.rows) {
    const b = PAGES[r.page];
    if (!b || r.d < w28 || r.d > end) continue;
    const m = spendByBranchDay.get(b) ?? new Map<string, number>();
    m.set(r.d, (m.get(r.d) ?? 0) + n(r.sp));
    spendByBranchDay.set(b, m);
  }
  for (const [b, m] of spendByBranchDay) {
    const s = sales.get(b);
    if (!s) continue;
    const zero = [...m.entries()].filter(([d, sp]) => sp > 0 && s.get(d) === 0).sort();
    if (!zero.length) continue;
    const spent = zero.reduce((a, [, sp]) => a + sp, 0) * 1.12;
    const dows = new Map<string, number>();
    for (const [d] of zero) dows.set(DOW[new Date(`${d}T00:00:00Z`).getUTCDay()], (dows.get(DOW[new Date(`${d}T00:00:00Z`).getUTCDay()]) ?? 0) + 1);
    const pattern = [...dows.entries()].filter(([, k]) => k >= 2).map(([w]) => `${w}s`);
    out.push({
      id: `zero-${b}`, check: "zeroDay", sev: zero.length >= 3 ? "bad" : "warn", line: null, tag: SHORT[b] ?? b,
      title: `${peso(spent)}* spent on ${zero.length} ₱0-sales day${zero.length === 1 ? "" : "s"}`,
      short: `${zero.slice(-3).map(([d]) => day(d)).join(", ")}${pattern.length ? ` · mostly ${pattern.join(" and ")}` : ""}`,
      why: `In the last 4 weeks ${SHORT[b]} declared ₱0 sales on ${zero.map(([d]) => day(d)).join(", ")} while its ads spent ${peso(spent)}*. If the clinic was closed or short of staff, those chats were wasted or went cold. First check the day's sales were typed in; if they were really ₱0${pattern.length ? ` and it keeps happening on ${pattern.join(" and ")}` : ""}, lower the budget on those days (ad scheduling) or fix the staffing.`,
      action: "Open daily sales", target: { kind: "page", href: "/sales/daily" },
      approve: `${SHORT[b]}: cut ads on ₱0-sales days (${zero.map(([d]) => day(d)).join(", ")})`,
    });
  }

  // 11. Audience wearing out: daily frequency up 25%+ and click rate down 20%+ vs two weeks earlier.
  type W = { im: number; cl: number; fq: number; k: number };
  const wk = new Map<string, { now: W; then: W }>();
  for (const r of feed.rows) {
    if (!r.sid) continue;
    const x = wk.get(r.sid) ?? { now: { im: 0, cl: 0, fq: 0, k: 0 }, then: { im: 0, cl: 0, fq: 0, k: 0 } };
    const into = r.d >= w7 && r.d <= end ? x.now : r.d >= w21a && r.d <= w21b ? x.then : null;
    if (into && n(r.im) > 0) { into.im += n(r.im); into.cl += n(r.cl); into.fq += n(r.fq) * n(r.im); into.k += n(r.im); }
    wk.set(r.sid, x);
  }
  for (const { l, s } of sets) {
    const x = wk.get(s.id);
    if (!x || x.now.im < 5000 || x.then.im < 5000) continue;
    const fNow = x.now.fq / x.now.k, fThen = x.then.fq / x.then.k, cNow = x.now.cl / x.now.im, cThen = x.then.cl / x.then.im;
    if (fNow >= fThen * 1.25 && cNow <= cThen * 0.8) {
      out.push({
        id: `sat-${s.id}`, check: "saturation", sev: "warn", line: l.key, tag: tagOf(l), title: "Audience wearing out",
        short: `Frequency ${fThen.toFixed(2)} → ${fNow.toFixed(2)} a day, clicks ${pct(cNow / cThen - 1)} lower`,
        why: `"${s.name}" shows its ads to the same people more often (${fThen.toFixed(2)} → ${fNow.toFixed(2)} times a day vs two weeks ago) and they click ${pct(cNow / cThen - 1)} less (${(cThen * 100).toFixed(1)}% → ${(cNow * 100).toFixed(1)}%). Add 1–2 genuinely new ads, or widen the area a little; don't add budget.`,
        action: "Open ad set", target: { kind: "adset", id: s.id, cid: s.cid, view: "edit" },
        approve: `${tagOf(l)}: freshen ad set "${s.name}" (audience wearing out)`,
      });
    }
  }

  const rank = { bad: 0, warn: 1, info: 2 };
  return out.sort((a, b) => rank[a.sev] - rank[b.sev]);
}

/** Ads Manager deep link for a campaign, ad set or ad (opens the edit panel, or the list with it selected). */
export function adsManagerUrl(t: Extract<Target, { kind: "campaign" | "adset" | "ad" }>, act: string | null) {
  const q = new URLSearchParams();
  if (act) q.set("act", act);
  if (t.view === "ads") {
    q.set("selected_adset_ids", t.id);
    return `https://adsmanager.facebook.com/adsmanager/manage/ads?${q}`;
  }
  q.set(`selected_${t.kind}_ids`, t.id);
  return `https://adsmanager.facebook.com/adsmanager/manage/${t.kind}s${t.view === "list" ? "" : "/edit"}?${q}`;
}

export type { AdSetView };
