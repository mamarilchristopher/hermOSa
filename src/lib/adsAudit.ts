/**
 * Ad advisor checks (v0.99.6, CHRIS Nov 28: "Apply such rigorous assessments of ads in all relevant data points we have").
 * Every check reads only data we have (the daily Meta feed with each ad set's targeting, declared daily sales and the
 * playbook) and points at the one ad, ad set or page to open. Spend is VAT-inclusive (*), budgets are before VAT.
 */
import { addDay, CLINIC_PIN, LEARN_PER_WEEK, PAGES, perChat, type AdSetView, type Feed, type LineView } from "./adsAdvisor";
import { SERVICE_LABEL } from "./ads";
import { bestRadius, CLINIC_SEARCH, locationOk } from "./adsSteps";

export type CheckKey = "pin" | "overlap" | "area" | "age" | "gender" | "split" | "setCost" | "dupe" | "zeroTag" | "zeroDay" | "cpcJump" | "quality" | "saturation";
/** Every check, in the order it is listed on the page. */
export const CHECKS: { key: CheckKey; label: string }[] = [
  { key: "pin", label: "Each ad set's pin is in its own branch's area" },
  { key: "overlap", label: "Branch circles don't reach another clinic" },
  { key: "area", label: "Each ad set is one pin on its clinic with the plan's radius (no town lists)" },
  { key: "age", label: "Ages 21+ and capped at the plan's top age" },
  { key: "gender", label: "Women only as a hard limit (men only in a separate test)" },
  { key: "split", label: "Ad sets get enough chats to leave learning" },
  { key: "setCost", label: "Ad sets in a line cost about the same per chat" },
  { key: "dupe", label: "No ad runs in two ad sets of the same line" },
  { key: "zeroTag", label: "Every ₱0 or blank day with ad spend is tagged (No sales or Closed)" },
  { key: "zeroDay", label: "₱0-sales days no more common than at the other branches (else a plan to fill them)" },
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
  /** Click-by-click steps someone else can follow (v0.99.8). Setting fixes get theirs from settingsPlan on the page. */
  steps?: string[];
  /** Overlap fixes: the circle size that stops short of the other clinic. */
  radius?: number;
};

const SHORT: Record<string, string> = { QC_MAIN: "QC Main", FAIRVIEW: "Fairview", STA_MARIA: "Sta. Maria", MARIKINA: "Marikina" };
const n = (v: unknown) => (v === null || v === undefined || v === "" ? 0 : Number(v) || 0);
const peso = (p: number) => `₱${Math.round(p).toLocaleString("en-US")}`;
const pct = (x: number) => `${Math.round(Math.abs(x) * 100)}%`;
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const FULL_DOW: Record<string, string> = { Sun: "Sunday", Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday" };
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
  plan: (branch: string, service: string) => { genders: string; ageMin: number; ageMax?: number } | null;
  /** Day marks per branch: NO_SALES = declared ₱0 day (tagged), CLOSED = clinic closed. Untagged ₱0 days have none. */
  marks?: Map<string, Map<string, "NO_SALES" | "CLOSED">>;
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
        const best = bestRadius(l.branch), fix = best < d - 0.2 ? best : Math.max(1, Math.floor(d - 0.5));
        out.push({
          id: `overlap-${s.id}-${code}`, name: s.name, check: "overlap", sev: "warn", line: l.key, tag: tagOf(l), title: `Shrink the circle to ${fix} mi`,
          short: `Its ${p.radius}-mile circle covers the ${SHORT[code]} clinic (${d.toFixed(1)} mi away)`,
          why: `"${s.name}" reaches ${p.radius} miles around ${p.name}; the ${SHORT[code]} clinic is ${d.toFixed(1)} miles away, so people near ${SHORT[code]} get ${SHORT[l.branch]} ads and chat with the farther clinic. Where our ad sets reach the same people, Meta enters only one of them in each auction and holds the others back (auction overlap), which slows their learning. Set the radius to about ${fix} miles so it stops short of ${SHORT[code]}, or keep it and exclude a 2-mile circle around the ${SHORT[code]} clinic.`,
          radius: fix, action: "Fix radius", target: { kind: "adset", id: s.id, cid: s.cid, view: "edit" },
          approve: `${tagOf(l)}: set ad set "${s.name}" radius to ${fix} mi`,
        });
        break;
      }
    }
  }

  // 2b. Location format (CHRIS Nov 28: "An address of the clinic + the best mile radius"): one pin on the branch's clinic,
  //     no wider than the plan's radius. Town lists and extra places get flagged (Meta turns towns into 10–25 mi circles).
  for (const { l, s } of sets) {
    const t = s.targeting;
    if (!t || s.mismatch || locationOk(l.branch, t)) continue;
    if (out.some((f) => f.check === "overlap" && f.target && f.target.kind === "adset" && f.target.id === s.id)) continue;
    const r = bestRadius(l.branch);
    const now = [...t.places.map((x) => `${x.radius ?? "?"} mi around "${x.name}"`), ...t.cities].join(" + ") || "no location";
    out.push({
      id: `area-${s.id}`, name: s.name, check: "area", sev: "warn", line: l.key, tag: tagOf(l), title: `Use the clinic pin + ${r} mi`,
      short: `"${s.name}" targets ${t.places.length + t.cities.length > 1 ? `${t.places.length + t.cities.length} places` : now}`,
      why: `"${s.name}" targets ${now}. The rule is one location: the ${SHORT[l.branch]} clinic's address with a ${r}-mile radius, which stops short of the other clinics. Town lists and extra places spread the ads into other branches' areas (Meta also widens towns into 10–25 mile circles). In Locations, remove them and add only "${CLINIC_SEARCH[l.branch]}" at ${r} mi.`,
      action: "Fix location", target: { kind: "adset", id: s.id, cid: s.cid, view: "edit" },
      approve: `${tagOf(l)}: set ad set "${s.name}" location to the ${SHORT[l.branch]} clinic + ${r} mi`,
    });
  }

  // 3–4. Ages under 21; not women-only as a hard limit (CHRIS Nov 28: about 90% of actual clients are women and ads
  //      open to men bring junk chats). With Advantage+ audience on, gender is only a suggestion, so men still see it.
  for (const { l, s } of sets) {
    const t = s.targeting;
    if (!t) continue;
    const plan = inp.plan(l.branch, l.service);
    const minAge = plan?.ageMin && plan.ageMin > 21 ? plan.ageMin : 21;
    // Top age (CHRIS Nov 28: demographics too): our 2 years of data show women 65+ cost the most per chat (₱53.8* vs
    // ₱41.7* at 25–34), so the playbook caps each line's ages. With Advantage+ audience the top age is only a suggestion.
    const maxAge = plan?.ageMax ?? null;
    const topNow = t.advantage ? (t.ageSuggest?.[1] ?? 65) : (t.ageMax ?? 65);
    const tooOld = maxAge !== null && topNow > maxAge;
    if ((t.ageMin ?? 18) < 21 || tooOld) {
      const range = maxAge !== null ? `${minAge}–${maxAge}` : `${minAge}+`;
      out.push({
        id: `age-${s.id}`, name: s.name, check: "age", sev: "warn", line: l.key, tag: tagOf(l),
        title: (t.ageMin ?? 18) < 21 && !tooOld ? `Raise the minimum age to ${minAge}` : `Set ages to ${range}`,
        short: `"${s.name}" reaches ages ${t.ageMin ?? 18}–${topNow}${t.advantage ? " (top age only suggested)" : ""}`,
        why: `${(t.ageMin ?? 18) < 21 ? `The house rule is 21+ for aesthetic ads (Meta's own floor for cosmetic procedures is 18). Under-21s rarely book and some need a parent's OK. ` : ""}${tooOld ? `The plan for this line is ages ${range}: in our own 2 years of Meta data, women 65+ cost the most per chat (₱53.8* vs ₱41.7* at 25–34). ` : ""}In the ad set's Audience, set Age to ${range}${t.advantage ? " after switching to original audience options (with Advantage+ audience only the minimum age is a hard limit)" : ""}.`,
        action: "Fix ages", target: { kind: "adset", id: s.id, cid: s.cid, view: "edit" },
        approve: `${tagOf(l)}: set ad set "${s.name}" ages to ${range}`,
      });
    }
    // A separate men-only TEST ad set with male-led creative is allowed (playbook v1.6); mixed gender never is.
    if (t.genders === "all" || t.advantage) {
      const open = t.genders === "all";
      out.push({
        id: `gender-${s.id}`, name: s.name, check: "gender", sev: "warn", line: l.key, tag: tagOf(l), title: "Make it women only",
        short: open ? `"${s.name}" shows to all genders` : `"${s.name}" uses Advantage+ audience, so men still see it`,
        why: `${open ? "This ad set shows to men and women." : "With Advantage+ audience on, Meta treats gender only as a suggestion, so the ads still reach the other gender."} Your rule: regular ad sets are women only as a hard limit (about 90% of actual clients are women; men bring junk chats); men are reached only by a separate men-only test ad set. In the ad set's Audience, switch to original audience options and set gender to Women. Changing the audience restarts learning, so do it together with any other fixes to this ad set.`,
        action: "Fix audience", target: { kind: "adset", id: s.id, cid: s.cid, view: "edit" },
        approve: `${tagOf(l)}: set ad set "${s.name}" to women only (original audience)`,
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
          steps: [`Tap "Open ad sets ↗" on this card. Ads Manager opens the ad set list (log in with the Hermosa account if asked).`, `Keep "${live.slice().sort((a, b) => (perChat(a.t7) ?? 1e9) - (perChat(b.t7) ?? 1e9))[0].name}" (cheapest per chat). For each other ad set (${live.length - 1}), open its ads, tick the running ones, click "Duplicate" and choose the kept ad set as the destination.`, `Add the other ad sets' daily budgets to the kept one (Budget & schedule), then turn the other ad sets Off.`, `Click "Publish".`, "Back in Hermosa OS, tap \"Done\" on this card."],
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
            steps: [`Tap "Open ad set ↗" on this card. Ads Manager opens on ad set "${worst.s.name}" (log in with the Hermosa account if asked).`, `In Budget & schedule, lower Daily budget by 20% (write down the amount you took off). Click "Publish".`, `Open ad set "${best.s.name}" and raise its Daily budget by that same amount. Click "Publish".`, "Back in Hermosa OS, tap \"Done\" on this card."],
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
        steps: [`Tap "Open ad ↗". Ads Manager opens with ad "${worse.name}" selected in ad set "${worse.adset}".`, `Turn that copy's On/Off switch to Off. Leave the other copy on.`, "Back in Hermosa OS, tap \"Done\" on this card."],
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
        steps: [`Tap "${top ? "Open ads" : "Open line"} ↗". Ads Manager opens this line's ads (log in with the Hermosa account if asked).`, `Sort by "Cost per result" for the last 7 days and note the ad whose cost rose most.`, `Don't raise any budget this week. Send the owner the ad's name and its cost per result now vs last week.`, "Back in Hermosa OS, tap \"Done\" on this card."],
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
      steps: [`Tap "Open inbox ↗" (Meta Business Suite inbox).`, `Open 20 chats from this week for ${SHORT[b]}. For each, note: minutes to first reply, whether the CSR asked for a booking date, and any price objection.`, `Send the owner the 3 most common reasons chats didn't book.`, "Back in Hermosa OS, tap \"Done\" on this card."],
      approve: `${SHORT[b]}: review chats and closing (sales per chat fell to ${peso(q7)})`,
    });
  }

  // 8. ₱0-sales days (CHRIS Nov 28). Two different jobs:
  //    a) a ₱0 or blank day that ads paid for and nobody tagged → data clarity: tag it (No sales / Closed) or type the sales;
  //    b) declared ₱0 days that are more common than at the other branches → a sales plan to fill those days, not an ad cut
  //       (ad chats book for later days, so cutting ads on the quiet day doesn't fill it; steering bookings into it does).
  const marks = inp.marks ?? new Map<string, Map<string, "NO_SALES" | "CLOSED">>();
  const spendByBranchDay = new Map<string, Map<string, { sp: number; m: number }>>();
  for (const r of feed.rows) {
    const b = PAGES[r.page];
    if (!b || r.d < w28 || r.d > end) continue;
    const m = spendByBranchDay.get(b) ?? new Map<string, { sp: number; m: number }>();
    const x = m.get(r.d) ?? { sp: 0, m: 0 };
    x.sp += n(r.sp); x.m += n(r.m);
    m.set(r.d, x);
    spendByBranchDay.set(b, m);
  }
  const days28 = Array.from({ length: 28 }, (_, i) => addDay(w28, i));
  const quiet = new Map<string, string[]>();
  for (const b of new Set([...spendByBranchDay.keys(), ...sales.keys()])) {
    const s = sales.get(b) ?? new Map<string, number>(), mk = marks.get(b) ?? new Map<string, "NO_SALES" | "CLOSED">();
    quiet.set(b, days28.filter((d) => s.get(d) === 0 && mk.get(d) === "NO_SALES"));
    const sp = spendByBranchDay.get(b);
    if (!sp) continue;
    const untagged = [...sp.entries()].filter(([d, x]) => x.sp > 0 && s.get(d) === 0 && mk.get(d) !== "NO_SALES").map(([d]) => d).sort();
    const blank = [...sp.entries()].filter(([d, x]) => x.sp > 0 && d <= addDay(end, -2) && !s.has(d) && !mk.has(d)).map(([d]) => d).sort();
    const all = [...untagged, ...blank].sort();
    if (!all.length) continue;
    const spent = all.reduce((a, d) => a + sp.get(d)!.sp, 0) * 1.12;
    out.push({
      id: `zerotag-${b}`, check: "zeroTag", sev: "warn", line: null, tag: SHORT[b] ?? b,
      title: `Tag ${all.length} ${all.length === 1 ? "day" : "days"} in Daily sales`,
      short: `${all.slice(-3).map(day).join(", ")}${all.length > 3 ? ` +${all.length - 3} more` : ""} · ads spent ${peso(spent)}*`,
      why: `${SHORT[b]}'s ads ran on ${all.map(day).join(", ")}, but ${untagged.length ? `${untagged.length === all.length ? "those days show" : `${untagged.map(day).join(", ")} show`} ₱0 without a "No sales" or "Closed" tag` : ""}${untagged.length && blank.length ? " and " : ""}${blank.length ? `${blank.map(day).join(", ")} ${blank.length === 1 ? "has" : "have"} no sales typed in` : ""}. Until each day is typed or tagged, the advisor can't tell a slow day from a missing entry, and ROAS for ${SHORT[b]} reads low.`,
      action: "Open daily sales", target: { kind: "page", href: "/sales/daily" },
      steps: [
        `Tap "Open daily sales →" and pick ${SHORT[b]}.`,
        `For each of ${all.map(day).join(", ")}: if there were sales, type the real total. If the clinic was open with no sales, mark it "No sales". If it was closed, mark it "Closed".`,
        `A second person confirms each No sales / Closed mark (the usual sign-off).`,
        `Back here, tap "Done" on this card.`,
      ],
      approve: `${SHORT[b]}: tag or type ${all.map(day).join(", ")} in Daily sales`,
    });
  }
  for (const [b, qd] of quiet) {
    if (!qd.length) continue;
    const others = [...quiet.entries()].filter(([x]) => x !== b).map(([, v]) => v.length);
    const usual = others.length ? others.reduce((a, x) => a + x, 0) / others.length : 0;
    const dows = new Map<string, number>();
    for (const d of qd) { const w = DOW[new Date(`${d}T00:00:00Z`).getUTCDay()]; dows.set(w, (dows.get(w) ?? 0) + 1); }
    const pattern = [...dows.entries()].filter(([, k]) => k >= 2).sort((x, y) => y[1] - x[1]).map(([w]) => w);
    if (!(qd.length >= 3 || (qd.length >= 2 && pattern.length > 0)) || qd.length < usual * 1.5) continue;
    const s = sales.get(b) ?? new Map<string, number>();
    const selling = days28.map((d) => s.get(d) ?? 0).filter((v) => v > 0);
    const perDay = selling.length ? selling.reduce((a, v) => a + v, 0) / selling.length / 100 : 0;
    const chats = qd.reduce((a, d) => a + (spendByBranchDay.get(b)?.get(d)?.m ?? 0), 0);
    const when = pattern.length ? pattern.map((w) => `${w}s`).join(" and ") : "quiet days";
    // The weekday to push first: the repeat one, else the one with the most ₱0 days (latest wins a tie).
    const top = pattern[0] ?? [...dows.entries()].sort((x, y) => y[1] - x[1] || qd.map((d) => DOW[new Date(`${d}T00:00:00Z`).getUTCDay()]).lastIndexOf(y[0]) - qd.map((d) => DOW[new Date(`${d}T00:00:00Z`).getUTCDay()]).lastIndexOf(x[0]))[0][0];
    const whenOne = pattern.length ? pattern.map((w) => FULL_DOW[w]).join(" or ") : `${FULL_DOW[top]} and other quiet weekdays (lately ${[...dows.keys()].join(", ")})`;
    out.push({
      id: `quiet-${b}`, check: "zeroDay", sev: qd.length >= 5 ? "bad" : "warn", line: null, tag: SHORT[b] ?? b,
      title: pattern.length ? `Fill ${SHORT[b]}'s ${when}` : `Fill ${SHORT[b]}'s quiet days`,
      short: `${qd.length} declared ₱0 days in 4 weeks (other branches ${usual.toFixed(1)})${perDay ? ` · a normal day sells ${peso(perDay)}` : ""}`,
      why: `${SHORT[b]} declared ₱0 sales on ${qd.map(day).join(", ")}${usual ? `, against ${usual.toFixed(1)} such days at the other branches` : ""}. ${perDay ? `A normal selling day there brings about ${peso(perDay)}, so these days left about ${peso(perDay * qd.length)} on the table. ` : ""}Ads kept bringing chats on those days (${chats} in all), and chats book for later dates, so cutting ads on ${when} won't fill them. The days are empty because no bookings were steered into them. The fix is in the chats and the clinic: offer the quiet day first, rebook the people who went quiet, bring package clients back on that day, and give a reason to choose it that doesn't cut the price.`,
      action: "Open bookings", target: { kind: "page", href: "/bookings" },
      steps: [
        `CSRs: in every new chat, offer ${whenOne} first, with 3 exact times ("May open slot po kami sa ${FULL_DOW[top]}: 11 AM, 2 PM o 4 PM"). Save it as a quick reply in the inbox.`,
        `Follow-ups: open Bookings › Follow-ups and offer every unresponsive client a ${FULL_DOW[top]} slot. Target: 3 rebooked for each ${FULL_DOW[top]}.`,
        `Packages: open Services › Packages, filter ${SHORT[b]}, and message clients with sessions left (Hiko touch-ups, drips, NovoForm) to book their next one on ${FULL_DOW[top]}.`,
        `Owner picks one ${FULL_DOW[top]}-only perk that adds value without cutting the price (for example a free Diamond Tip upgrade with Hiko, or a free gluta booster with a drip). Set it up in Promos so it's tracked; never show a "regular price".`,
        `Ads: keep budgets as they are. Two days before each ${FULL_DOW[top]}, add one ad in ${SHORT[b]}'s ad set that names the day and the perk ("This ${FULL_DOW[top]} only at Hermosa ${SHORT[b]}"). Claude can prepare it after the owner's OK.`,
        `Staffing: check that a CMA who does Hiko is rostered on ${pattern.length ? when : `${FULL_DOW[top]}s and the other quiet days`}. If it's a common day off, swap one.`,
        `In 2 weeks the advisor counts again. Goal: at most 1 ₱0 day a month at ${SHORT[b]}.`,
      ],
      approve: `${SHORT[b]}: start the ${when} fill plan (CSR first-offer script, follow-ups, package rebooking, one perk for the owner to pick)`,
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
        steps: [`Tap "Open ad set ↗". Ads Manager opens on ad set "${s.name}" (log in with the Hermosa account if asked).`, `Duplicate the best ad in it and swap in a new video from the Hermosa ad library (or a new first line of text). Name it with " v2".`, `Don't add budget. Click "Publish".`, "Back in Hermosa OS, tap \"Done\" on this card."],
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
