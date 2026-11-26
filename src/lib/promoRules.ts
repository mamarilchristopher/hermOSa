/**
 * Promo generator rules (CHRIS Nov 27): repeat-safety per service, pricing math, PH seasons, captions and the
 * Monday suggestions. Shared by the Promos page (server) and the builder (browser).
 * Never show a "regular price" on any material (CHRIS Nov 24): images and captions show only the promo price,
 * the session count and the price per session.
 */

// ---------- Repeat safety and the usual frequency (CHRIS Nov 27: bundles follow how often a service is really done) ----------
/** gapDays: shortest safe gap; maxYear: most per year; perMonth: the usual pace while on a program (gluta drips are weekly = 4);
 *  ads: false = organic posts only (prescription drugs and unapproved products can't be advertised: Meta + PH FDA). */
export type Safety = { gapDays: number; maxYear: number; perMonth: number; bundleOk: boolean; ads: boolean; usual: string; note: string };

const S = (gapDays: number, maxYear: number, perMonth: number, usual: string, note: string, bundleOk = true, ads = true): Safety =>
  ({ gapDays, maxYear, perMonth, usual, note, bundleOk, ads });

const SAFETY: [RegExp, Safety][] = [
  [/hiko|thread|diamond tip|fox eye|hexalift|v ?lift|mono/i, S(180, 2, 0, "One procedure, touch-up after about 6 months", "Thread lifts are one procedure with touch-ups, not repeat sessions.", false)],
  [/filler/i, S(180, 2, 0, "Lasts 6 to 12 months", "Fillers last 6 to 12 months; not for repeat bundles.", false, false)],
  [/microshading|lip blush/i, S(30, 2, 0, "One procedure plus one touch-up", "Brows and lips are one procedure plus one touch-up.", false)],
  [/wart|skin ?tag/i, S(30, 2, 0, "One-off", "Removal is a one-off treatment.", false)],
  [/novoform/i, S(7, 52, 4, "Weekly, doctor-guided", "Novoform is doctor-guided and a prescription drug: keep it out of promos.", false, false)],
  [/barbie/i, S(14, 3, 0, "A 3-dose treatment", "Barbie Arms is already a 3-dose treatment.", false, false)],
  [/botox|jawtox|sweatox|alar|beauty-?tox/i, S(90, 4, 0.33, "Every 3 to 4 months", "Botox at least 3 months apart (4 a year at most). Prescription drug: organic posts only, never paid ads.", true, false)],
  [/lemon bottle/i, S(7, 12, 2, "Weekly to every 2 weeks, about 4 to 6", "Fat dissolving weekly to every 2 weeks. Not approved by regulators abroad: organic posts only.", true, false)],
  [/hifu face|hifu.*neck/i, S(150, 2, 0.17, "Every 6 months (2 a year)", "Face HIFU about every 6 months; 2 a year per area.")],
  [/hifu/i, S(30, 6, 1, "Monthly, 3 to 6 sessions", "Body HIFU about a month apart.")],
  [/carbon/i, S(14, 24, 1, "Every 2 to 4 weeks (monthly to maintain)", "Carbon laser every 2 to 4 weeks.")],
  [/diode|underarm.*ipl|ipl/i, S(28, 10, 1, "Every 4 to 6 weeks, 6 to 10 sessions", "Hair removal every 4 to 6 weeks (6 to 10 sessions is a full course).")],
  [/mesolipo|meso/i, S(7, 12, 1, "Every 1 to 4 weeks, up to about 6 to 10", "Fat dissolving every 1 to 2 weeks, up to about 10 sessions.")],
  [/v[ -]?contour|\brf\b|rf slimming/i, S(7, 24, 2, "Weekly for 6 to 8, then monthly", "RF contouring weekly during a course.")],
  [/lux queen|illumina|brilliant|gluta|drip/i, S(7, 52, 4, "Weekly (4 a month)", "Gluta drips are weekly. Never say whitening or pampaputi: posts talk about glow and hydration only.", true, false)],
  [/l-carnitine/i, S(7, 52, 4, "Weekly with a drip", "Add-on with a weekly drip.")],
  [/bb glow/i, S(14, 12, 1, "Every 2 to 4 weeks, 3 to 5 sessions", "BB Glow every 2 to 4 weeks.")],
  [/acne|kan[ao]lone|pdt|pricking/i, S(14, 26, 2, "Every 2 weeks during a course", "Acne facials every 2 weeks during a course.")],
  [/facial|peel|hydra/i, S(14, 26, 1, "Monthly (every 2 to 4 weeks)", "Facials every 2 to 4 weeks.")],
];
const DEFAULT_SAFETY: Safety = S(14, 12, 1, "Ask the clinic doctor", "Check the spacing with the clinic doctor.");

export const safetyFor = (name: string): Safety => SAFETY.find(([re]) => re.test(name))?.[1] ?? DEFAULT_SAFETY;

/** Sessions a client would normally get in the given months at the usual pace (0 = not a repeat service). */
export const usualCount = (name: string, months: number) => {
  const f = safetyFor(name);
  return Math.min(Math.round(f.perMonth * months), Math.ceil((f.maxYear * Math.max(12, months)) / 12));
};

/** Items far below the usual pace for the months given: on a long program they don't feel worth it (CHRIS Nov 27). */
export function thinItems(items: PromoItem[], months: number): string[] {
  if (months < 2) return [];
  return items.flatMap((it) => {
    const usual = usualCount(it.name, months), n = it.paid + it.free;
    return safetyFor(it.name).perMonth >= 4 && usual >= 3 && n < usual * 0.6
      ? [`${it.name}: ${n} in ${months} months is far below the usual pace (${safetyFor(it.name).usual.toLowerCase()}, about ${usual}). Clients may not find it worth it.`]
      : [];
  });
}

export type PromoItem = { service_id: string; name: string; unit: number; paid: number; free: number };

/** Problems with a bundle for the client's safety: not repeat-safe, or too many sessions for the time allowed. */
export function safetyIssues(items: PromoItem[], months: number): string[] {
  const out: string[] = [];
  for (const it of items) {
    const s = safetyFor(it.name), n = it.paid + it.free;
    const allowed = Math.max(1, Math.ceil((s.maxYear * Math.max(12, months)) / 12));
    if (!s.bundleOk && n > allowed) { out.push(`${it.name}: ${s.note}`); continue; }
    const spanDays = (n - 1) * s.gapDays;
    if (n > allowed || spanDays > months * 31) {
      out.push(`${it.name}: ${n} sessions in ${months} month${months === 1 ? "" : "s"} is too many. ${s.note}`);
    }
  }
  return out;
}

// ---------- Pricing ----------
export const sessionsOf = (items: PromoItem[]) => items.reduce((n, i) => n + i.paid + i.free, 0);
export const valueOf = (items: PromoItem[]) => items.reduce((n, i) => n + i.unit * (i.paid + i.free), 0);
export const paidValueOf = (items: PromoItem[]) => items.reduce((n, i) => n + i.unit * i.paid, 0);
/** A one-service bundle is a Sales log bundle (session-by-session); anything else is a program sold once. */
export const isBundle = (items: PromoItem[]) => items.length === 1 && sessionsOf(items) <= 15;

/** A clean promo price at or below the given amount: ₱24,999 rather than ₱25,312 (cents). */
export function nicePrice(cents: number): number {
  const p = Math.floor(cents / 100);
  if (p >= 10000) return (Math.floor((p + 1) / 1000) * 1000 - 1) * 100;
  if (p >= 2000) return (Math.floor((p + 1) / 100) * 100 - 1) * 100;
  return p * 100;
}

/** The default price: a bundle charges the paid sessions only; a program takes a further ~25% off the paid value. */
/** Existing Service log packages (e.g. "Lux Queen 10+3" at ₱19,999 in total), so a matching bundle never costs more. */
export type Pkg = { name: string; total: number };
const baseName = (n: string) => n.replace(/\s*single session$/i, "").trim().toLowerCase();
export function packagePrice(items: PromoItem[], pkgs: Pkg[] = []): number | null {
  if (items.length !== 1) return null;
  const want = `${baseName(items[0].name)} ${items[0].paid}+${items[0].free}`;
  return pkgs.find((p) => p.name.trim().toLowerCase() === want && p.total > 0)?.total ?? null;
}

/** The default price: a bundle charges the paid sessions only (or the existing package price if lower); a program takes a
 *  further ~20% off the paid value. */
export const defaultPrice = (items: PromoItem[], pkgs: Pkg[] = []) => {
  if (!isBundle(items)) return nicePrice(Math.round(paidValueOf(items) * 0.8));
  const pk = packagePrice(items, pkgs);
  return pk != null ? Math.min(pk, paidValueOf(items)) : paidValueOf(items);
};

/** Commission in cents: a bundle pays 5% of its price spread over every session; a program pays 5% once, when sold. */
export const commissionPerSession = (items: PromoItem[], price: number) =>
  isBundle(items) ? Math.round((price * 0.05) / Math.max(1, sessionsOf(items))) : Math.round(price * 0.05);

export const peso = (c: number) => `₱${Math.round(c / 100).toLocaleString("en-PH")}`;

/** "5 + 2 FREE" for one service, "24 sessions" for a program. */
export function mechanic(items: PromoItem[]): string {
  if (items.length === 1) return items[0].free > 0 ? `${items[0].paid} + ${items[0].free} FREE` : `${items[0].paid} sessions`;
  return `${sessionsOf(items)} sessions`;
}

// ---------- Seasons (Philippines) ----------
export type Season = { key: string; name: string; from: [number, number]; to: [number, number]; angle: string; fits: RegExp };

export const SEASONS: Season[] = [
  { key: "ber", name: "Christmas party season", from: [11, 15], to: [12, 24], angle: "Party-ready glow for every Christmas party", fits: /gluta|lux queen|illumina|facial|hydra|carbon|hiko|botox/i },
  { key: "1212", name: "12.12 sale", from: [12, 5], to: [12, 12], angle: "One-day 12.12 deal, prepaid", fits: /hifu|diode|carbon|facial|gluta|v[ -]?contour|mesolipo/i },
  { key: "newyear", name: "New Year, New Me", from: [12, 26], to: [1, 20], angle: "A whole year of glow, paid once", fits: /hifu|v[ -]?contour|mesolipo|lemon bottle|rf|facial|carbon|gluta/i },
  { key: "valentine", name: "Valentine's", from: [1, 25], to: [2, 14], angle: "Glow together: couples and best friends", fits: /facial|hydra|gluta|lip|carbon|bb glow|botox/i },
  { key: "summer", name: "Summer season", from: [3, 1], to: [5, 31], angle: "Sleeveless season: book your contour and smooth-skin sessions early", fits: /diode|underarm|\bua\b|hifu (arms|tummy|back)|mesolipo|lemon bottle|v[ -]?contour|sweatox|whitening/i },
  { key: "grad", name: "Graduation and prom", from: [3, 15], to: [4, 30], angle: "Glowing in every photo on the big day", fits: /facial|hydra|carbon|bb glow|gluta|acne/i },
  { key: "mothers", name: "Mother's Day", from: [4, 25], to: [5, 12], angle: "Treat Mom: book together", fits: /facial|hydra|gluta|rf|hifu face|botox/i },
  { key: "rainy", name: "Rainy season skin care", from: [6, 1], to: [8, 31], angle: "Your skin routine for the rainy months", fits: /acne|facial|peel|hydra|carbon|kanolone/i },
  { key: "school", name: "Back to school", from: [7, 15], to: [8, 31], angle: "A fresh-skin routine for the new school year", fits: /acne|facial|carbon|diode/i },
  { key: "saledays", name: "9.9, 10.10 and 11.11 sale days", from: [9, 1], to: [11, 11], angle: "Double-day sale: prepay and save", fits: /hifu|diode|carbon|facial|gluta|v[ -]?contour/i },
];

const md = (d: Date) => (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
function inWindow(s: Season, d: Date) {
  const v = md(d), a = s.from[0] * 100 + s.from[1], b = s.to[0] * 100 + s.to[1];
  return a <= b ? v >= a && v <= b : v >= a || v <= b;
}
/** Seasons running now or starting within the next 3 weeks (dates as yyyy-mm-dd, Manila). */
export function upcomingSeasons(today: string): Season[] {
  const t = new Date(`${today}T00:00:00Z`);
  const soon = new Date(t.getTime() + 21 * 86400000);
  return SEASONS.filter((s) => inWindow(s, t) || inWindow(s, soon));
}

// ---------- Titles and captions ----------
const BUNDLE_TITLES: [RegExp, string[]][] = [
  [/hifu (arms|tummy|back)|mesolipo|lemon bottle|v[ -]?contour|\brf body/i, ["The Sculpt Sprint", "Contour Club", "Summer Contour Pass", "Sleeveless Season Pass"]],
  [/hifu/i, ["Lifted Look Pass", "The Contour Club", "V-Line Season"]],
  [/diode|underarm|\bua\b|whitening|sweatox/i, ["Smooth Season Pass", "Sleeveless Season", "Forever Smooth"]],
  [/gluta|lux queen|illumina|brilliant/i, ["The Glow Drip Club", "Lit From Within", "Glow Getter Pass"]],
  [/carbon/i, ["The Carbon Glow Club", "Clear Skin Sprint", "Poreless Pass"]],
  [/acne|kanolone|pdt|peel/i, ["Clear Skin Sprint", "Breakout Rescue Pass"]],
  [/facial|hydra|bb glow|glass skin/i, ["Glass Skin Club", "Monthly Glow Pass", "The Lunchbreak Glow"]],
  [/botox|jawtox/i, ["The Fresh Face Pass", "Smooth Operator"]],
];
export function titleIdeas(items: PromoItem[], season?: Season): string[] {
  const out: string[] = [];
  if (season?.key === "ber") out.push("The Christmas Glow-Up");
  if (season?.key === "newyear") out.push("New Year, New Glow");
  if (season?.key === "valentine") out.push("Glow Together");
  if (season?.key === "1212") out.push("12.12 Glow Steal");
  if (season?.key === "summer") out.push("Summer-Ready Pass");
  if (season?.key === "mothers") out.push("Mom & Me Glow Day");
  for (const it of items) for (const [re, t] of BUNDLE_TITLES) if (re.test(it.name)) out.push(...t);
  if (items.length > 1) out.push("Hermosa Black Card", "Glow Year Club", "The Maintenance Membership");
  out.push("Buy More, Glow More");
  return [...new Set(out)];
}

// ---------- Ad rules check (CHRIS: always cross-check posts with the latest Meta ad policy) ----------
// Meta Advertising Standards (personal health and appearance, personal attributes, 18+ for cosmetic procedures and weight
// loss), PH FDA (no injectable is approved for skin lightening; prescription drugs can't be advertised to the public),
// ASC (absolute claims need proof). Research: /mnt/project-files/research/PH aesthetic clinic bundle offers.md
const AD_RULES: [RegExp, string][] = [
  [/whiten|whitening|pampaputi|maputi|lighten|fair(er)? skin|kutis ?porselana/i, "Avoid \"whitening\" words: Meta flags skin lightening, and PH FDA says no injectable is approved for it. Say glow, radiance or hydration."],
  [/\bslim|fat\b|fat burn|melt|lose \d|\d+ ?(kg|kilos?|inches|lbs)|weight ?loss|pumayat/i, "Weight-loss wording: boost only to ages 18+, no before/after, and say \"body contouring\" instead of slimming or fat burning."],
  [/guarantee|permanent|100 ?%|instant|overnight|best in|#1|no\. ?1|number one|most trusted/i, "Absolute claims (guaranteed, permanent, #1) need independent proof under the Ad Standards Council code. Drop them or say \"results vary\"."],
  [/tired of|insecure|ashamed|do you have|are you (fat|chubby)|your (fat|flab|wrinkles?|acne|pimples?|dark|chubby|double chin|belly|bilbil|love handles)/i, "Don't point at the viewer's body or skin problem (Meta personal attributes rule). Describe the treatment instead."],
  [/snatched|body goals|bikini body|beach body|summer body|perfect body|flawless body/i, "Body-ideal wording can break Meta's negative self-perception rule. Use the service or occasion (e.g. \"Summer Contour Pass\")."],
  [/botox|toxin|tirzepatide|semaglutide|ozempic|mounjaro|novoform|lemon bottle/i, "Prescription drug or unapproved product: post it organically only, never as a paid ad, and don't name the drug in ads."],
];

/** Services in the promo that can only be posted organically (prescription drugs such as IV glutathione and Botox, or
 *  unapproved products): fine on the page and in Messenger, but not as a boosted post or paid ad. */
export function organicOnly(items: PromoItem[]): string[] {
  const names = items.filter((i) => !safetyFor(i.name).ads).map((i) => i.name);
  return names.length
    ? [`Post organically only, don't boost: ${names.join(", ")} (prescription drug or unapproved product). For a paid ad, lead with the other services and give these details in Messenger.`]
    : [];
}

/** Ad rule problems in promo text (title, tagline, captions), each with what to do instead. */
export function adIssues(...texts: string[]): string[] {
  const t = texts.join("\n");
  return AD_RULES.filter(([re]) => re.test(t)).map(([, why]) => why);
}

export const BRANCH_LINE = "QC Main · Fairview · Sta. Maria · Marikina";

export function captions(p: { title: string; tagline?: string; items: PromoItem[]; price: number; months: number; endsOn?: string | null }) {
  const n = sessionsOf(p.items);
  const per = peso(Math.round(p.price / Math.max(1, n)));
  const until = p.endsOn ? ` until ${new Date(`${p.endsOn}T00:00:00Z`).toLocaleDateString("en-PH", { month: "long", day: "numeric", timeZone: "UTC" })}` : "";
  const what = p.items.length === 1
    ? `${p.items[0].paid} ${p.items[0].name} sessions${p.items[0].free ? ` + ${p.items[0].free} FREE` : ""}`
    : p.items.map((i) => `${i.paid + i.free} × ${i.name}`).join("\n• ");
  const story = `${p.title.toUpperCase()} ✨\n${p.items.length === 1 ? mechanic(p.items) + " " + p.items[0].name : `${n} sessions, one price`}\n${peso(p.price)} only (${per}/session)\nAvailable${until} 💛 DM us to book!`;
  const feed = `${p.title} ✨${p.tagline ? `\n${p.tagline}` : ""}\n\n${p.items.length === 1 ? what : `What's inside:\n• ${what}`}\n\n💛 ${peso(p.price)} for ${n} sessions, just ${per} per session\n🗓️ Use within ${p.months} month${p.months === 1 ? "" : "s"}${until ? `\n⏳ Promo runs${until}` : ""}\n\n📍 ${BRANCH_LINE}\n📩 Send us a message to book your slot. Slots are limited!\n\n#HermosaAesthetics #LetYourBeautyShine #GlowUp #AestheticClinic #SkincarePH`;
  return { story, feed };
}

// ---------- Monday suggestions ----------
export type SvcStat = { id: string; name: string; price: number; recent: number; before: number; recentCents: number };
export type Suggestion = { id: string; kind: "SEASON" | "SLOW" | "PROGRAM"; why: string; title: string; tagline: string; items: PromoItem[]; price: number; months: number; season?: string };

/** Paid + free counts at the usual pace (CHRIS Nov 27): weekly services (gluta drips, RF) get 10 + 3 (about 3 months),
 *  every-2-to-4-week services 5 + 1, pricier monthly ones 3 + 1, the rest 2. */
function countsFor(name: string, unit: number): [number, number] {
  const s = safetyFor(name);
  if (s.perMonth >= 4) return [10, 3];
  if (s.perMonth >= 1) return unit >= 400000 ? [3, 1] : [5, 1];
  return [2, 0];
}

/** Year-long programs from the Nov 27 competitor research (/mnt/project-files/research/PH aesthetic clinic bundle offers.md):
 *  hero services stay near their best package rate; the year's extra comes from a cheap device session (HIFU) and perks.
 *  price = the researched prepaid price in pesos (the builder still lets you change it). */
const PROGRAMS: { title: string; tagline: string; months: number; price: number; why: string; parts: [RegExp, number][] }[] = [
  { title: "Glow Year", tagline: "Weekly glow drips, a monthly facial and HIFU twice a year", months: 12, price: 44999,
    why: "Gluta drips are weekly, so a year is 48 drips (CHRIS Nov 27). Per drip it stays at the 10+3 rate; the 2 HIFU sessions reward the 1-year commitment.",
    parts: [[/^brilliant single/i, 48], [/^signature facial$/i, 12], [/^hifu face and neck$/i, 2]] },
  { title: "Glow Year Lux", tagline: "Lux Queen drips every week, a monthly facial and HIFU twice a year", months: 12, price: 88999,
    why: "The premium Glow Year: 48 Lux Queen drips, 12 facials and 2 face HIFU. Offer it to Lux Queen 10+3 buyers.",
    parts: [[/^lux queen single/i, 48], [/^signature facial$/i, 12], [/^hifu face and neck$/i, 2]] },
  { title: "Hiko Year", tagline: "Your Hiko now, a refresh in 6 months and 2 Glass Skin facials", months: 12, price: 16999,
    why: "Nose threads last about 6 months, so the best seller gets a planned second visit. Sell it on the day of the Hiko: ₱8,999 now, the rest monthly.",
    parts: [[/^hiko deluxe$/i, 2], [/^glass skin hydrafacial$/i, 2]] },
  { title: "V-Line Year", tagline: "Ultra V Lift, monthly V-Contour and facials, and HIFU at month 6", months: 12, price: 21999,
    why: "Turns Ultra V Lift buyers into a 6-month maintenance habit (V-Contour monthly, up to 6), with one more face HIFU.",
    parts: [[/^ultra ?v ?lift$/i, 1], [/^v[ -]?contour$/i, 5], [/^signature facial$/i, 6], [/^hifu face and neck$/i, 1]] },
  { title: "Body Contour 6-Month", tagline: "Monthly contour sessions, weekly RF and one tummy HIFU", months: 6, price: 24999,
    why: "A device-led body program to use instead of Lemon Bottle: mesolipo monthly (6), RF weekly then monthly (12), 1 tummy HIFU.",
    parts: [[/^mesolipo arms/i, 6], [/^rf body single/i, 12], [/^hifu tummy$/i, 1]] },
  { title: "Glass Skin Year", tagline: "Hydrafacial and carbon laser, alternating every month", months: 12, price: 19999,
    why: "A low-ticket year for facial clients: 6 Glass Skin Hydrafacials alternating with 6 carbon laser face sessions.",
    parts: [[/^glass skin hydrafacial$/i, 6], [/^carbon laser face$/i, 6]] },
  { title: "Smooth Underarm Year", tagline: "8 underarm laser sessions and a facial every 2 months", months: 12, price: 11999,
    why: "Diode every 5 to 6 weeks (8 a year) plus 6 facials; about ₱900 a laser visit vs ₱1,300+ at mall chains.",
    parts: [[/^diode underarms$/i, 8], [/^signature facial$/i, 6]] },
];

export function suggest(stats: SvcStat[], today: string, pkgs: Pkg[] = []): Suggestion[] {
  const out: Suggestion[] = [];
  const usable = stats.filter((s) => s.price > 0 && safetyFor(s.name).bundleOk && safetyFor(s.name).perMonth > 0 && (safetyFor(s.name).ads || safetyFor(s.name).perMonth >= 4) && !/test service|single session.*double|double dose/i.test(s.name));
  const mk = (s: SvcStat, kind: Suggestion["kind"], why: string, season?: Season): Suggestion => {
    const [paid, free] = countsFor(s.name, s.price);
    const items = [{ service_id: s.id, name: s.name, unit: s.price, paid, free }];
    const months = Math.max(1, Math.min(12, Math.ceil((paid + free) / Math.max(0.25, safetyFor(s.name).perMonth)) + 1));
    const title = titleIdeas(items, season)[0];
    return { id: `${kind}-${s.id}-${season?.key ?? ""}`, kind, why, title, tagline: season?.angle ?? `${s.name}: more sessions, better results`, items, price: defaultPrice(items, pkgs), months, season: season?.name };
  };
  // 1. Seasons: the best-selling fitting service gets a seasonal bundle; a quieter fitting one gets a second.
  for (const season of upcomingSeasons(today)) {
    const fit = usable.filter((s) => season.fits.test(s.name)).sort((a, b) => b.recentCents - a.recentCents);
    if (fit[0]) out.push(mk(fit[0], "SEASON", `${season.name}: ${season.angle.toLowerCase()}. ${fit[0].name} sold ${fit[0].recent} in the last 4 weeks.`, season));
    const quiet = fit.slice(1).find((s) => s.recent <= 2);
    if (quiet) out.push(mk(quiet, "SEASON", `${season.name}, and ${quiet.name} has been quiet (${quiet.recent} in 4 weeks): a bonus session gives it a push.`, season));
  }
  // 2. Slow movers: sold 0-1 times in 4 weeks, or down 40%+ from the 4 weeks before.
  const slow = usable
    .filter((s) => s.recent <= 1 || (s.before >= 3 && s.recent <= s.before * 0.6))
    .sort((a, b) => b.price - a.price)
    .slice(0, 3);
  for (const s of slow) {
    if (out.some((o) => o.items[0]?.service_id === s.id)) continue;
    out.push(mk(s, "SLOW", s.recent <= 1 ? `${s.name} sold ${s.recent} in the last 4 weeks. A bonus-session bundle makes it easier to say yes.` : `${s.name} dropped from ${s.before} to ${s.recent} sales vs the 4 weeks before.`));
  }
  // 3. Two year-long programs each week (rotating by week number), priced from the research and checked against today's prices.
  const week = Math.floor(new Date(`${today}T00:00:00Z`).getTime() / (7 * 86400000));
  let added = 0;
  // Glow Year (weekly drips, the best-selling habit) every week, plus one other program in rotation.
  const order = [PROGRAMS[0], ...Array.from({ length: PROGRAMS.length - 1 }, (_, k) => PROGRAMS[1 + ((week + k) % (PROGRAMS.length - 1))])];
  for (let k = 0; k < order.length && added < 2; k++) {
    const pr = order[k];
    const items: PromoItem[] = [];
    for (const [re, n] of pr.parts) { const s = stats.find((x) => re.test(x.name) && x.price > 0); if (s) items.push({ service_id: s.id, name: s.name, unit: s.price, paid: n, free: 0 }); }
    if (items.length !== pr.parts.length) continue;
    const price = Math.min(pr.price * 100, valueOf(items));
    out.push({ id: `PROGRAM-${pr.title}`, kind: "PROGRAM", why: pr.why, title: pr.title, tagline: pr.tagline, items, price, months: pr.months });
    added++;
  }
  return out;
}
