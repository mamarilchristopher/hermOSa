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
  // CHRIS Nov 27: priced from our CURRENT package price, not the single price. With a package for the service, a promo
  // bundle is about 5% under it (a reason to buy now without undercutting the package); otherwise paid sessions only.
  if (packageRate(items[0].name, pkgs)) return Math.min(paidValueOf(items), nicePrice(Math.round(currentValue(items, pkgs).value * 0.95)));
  const pk = packagePrice(items, pkgs);
  return pk != null ? Math.min(pk, paidValueOf(items)) : paidValueOf(items);
};

/** Commission per session done (CHRIS Nov 27, update-0087): the service's usual commission for one session (its set
 *  commission, else 5% of its list price), lowered by the promo's discount. Free sessions are included, unused sessions pay
 *  nothing, so a promo never pays more than the usual 5% of what the client actually paid. Same math as approve_promo. */
export function partCommission(unit: number, usualCommission: number | null | undefined, price: number, value: number): number {
  const base = usualCommission ?? Math.round(unit * 0.05);
  return value > 0 ? Math.round((base * Math.min(price, value)) / value) : 0;
}
/** Per-session commission for each item, in item order. `usual` maps a service id to its set commission (null = 5%). */
export const commissionsOf = (items: PromoItem[], price: number, usual: Record<string, number | null> = {}) =>
  items.map((i) => partCommission(i.unit, usual[i.service_id], price, valueOf(items)));
/** Kept for older callers: the first item's per-session commission. */
export const commissionPerSession = (items: PromoItem[], price: number, usual: Record<string, number | null> = {}) => commissionsOf(items, price, usual)[0] ?? 0;

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
    ? `${p.items[0].paid}${p.items[0].free ? ` + ${p.items[0].free} FREE` : ""} sessions of ${adNameLong(p.items[0].name)}`
    : p.items.map((i) => `${i.paid + i.free} × ${adName(i.name)}`).join("\n• ");
  const story = `${p.title.toUpperCase()} ✨\n${p.items.length === 1 ? `${mechanic(p.items)} sessions of ${adNameLong(p.items[0].name)}`.replace("sessions sessions", "sessions") : `${n} sessions, one price`}\n${peso(p.price)} only (${per}/session)\nAvailable${until} 💛 DM us to book!`;
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
    return { id: `${kind}-${s.id}-${season?.key ?? ""}`, kind, why, title, tagline: season?.angle ?? `${adName(s.name)}: more sessions, better results`, items, price: defaultPrice(items, pkgs), months, season: season?.name };
  };
  // 1. Seasons: the best-selling fitting service gets a seasonal bundle; a quieter fitting one gets a second.
  for (const season of upcomingSeasons(today)) {
    const fit = usable.filter((s) => season.fits.test(s.name)).sort((a, b) => b.recentCents - a.recentCents);
    if (fit[0]) out.push(mk(fit[0], "SEASON", `${season.name} is coming. ${adName(fit[0].name)} sold ${fit[0].recent} in 4 weeks.`, season));
    const quiet = fit.slice(1).find((s) => s.recent <= 2);
    if (quiet) out.push(mk(quiet, "SEASON", `${season.name} is coming, and ${adName(quiet.name)} has been quiet (${quiet.recent} in 4 weeks).`, season));
  }
  // 2. Slow movers: sold 0-1 times in 4 weeks, or down 40%+ from the 4 weeks before.
  const slow = usable
    .filter((s) => s.recent <= 1 || (s.before >= 3 && s.recent <= s.before * 0.6))
    .sort((a, b) => b.price - a.price)
    .slice(0, 3);
  for (const s of slow) {
    if (out.some((o) => o.items[0]?.service_id === s.id)) continue;
    out.push(mk(s, "SLOW", s.recent <= 1 ? `${adName(s.name)} sold ${s.recent} in 4 weeks. A bonus session makes it an easy yes.` : `${adName(s.name)} dropped from ${s.before} to ${s.recent} sales vs the 4 weeks before.`));
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

// ---------- Recommended schedule (CHRIS Nov 27: every bundle and program comes with a plan for the client and the clinic) ----------
/** One planned session: date, the Service log item (or service) id, and its number for that item. */
export type PlanStep = { d: string; s: string; n: number };
export type PlanPart = { id: string; name: string; sessions: number; from?: number };
const addD = (d: string, n: number) => new Date(new Date(`${d}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);
const addM = (d: string, m: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() + m); return x.toISOString().slice(0, 10); };
export const promoEnds = (start: string, months: number) => addD(addM(start, months), -1);

/** Spread each item's sessions over the months at its usual pace (weekly drips, monthly facials, face HIFU every 6 months),
 *  never closer than the safe gap. The most frequent item sets the visit rhythm; the others land on those visit days
 *  (second visit, third visit...) so the client comes in as few times as possible. `from` = sessions already done. */
export function promoSchedule(parts: PlanPart[], start: string, months: number, end?: string): PlanStep[] {
  const last = end ?? promoEnds(start, months);
  const span = Math.max(0, Math.round((new Date(`${last}T00:00:00Z`).getTime() - new Date(`${start}T00:00:00Z`).getTime()) / 86400000) - 7);
  const plan = parts.map((p) => {
    const s = safetyFor(p.name);
    const left = Math.max(0, p.sessions - (p.from ?? 0));
    const usual = Math.max(s.gapDays, Math.round(28 / Math.max(s.perMonth, 1 / 12)));
    const fit = left > 1 ? Math.floor(span / (left - 1)) : usual;
    return { p, left, every: Math.max(s.gapDays, Math.min(usual, fit)) };
  }).filter((x) => x.left > 0).sort((a, b) => a.every - b.every);
  const out: PlanStep[] = [];
  const rhythm = plan[0]?.every ?? 30;
  plan.forEach((x, k) => {
    // Later items start on the (k+1)th visit of the main rhythm, if they still fit.
    let every = x.every, offset = 0;
    if (k > 0 && rhythm > 0) {
      const up = Math.ceil(every / rhythm) * rhythm, down = Math.floor(every / rhythm) * rhythm;
      every = (x.left - 1) * up <= span ? up : down >= safetyFor(x.p.name).gapDays ? down : every;
      offset = Math.min(k * rhythm, Math.max(0, span - (x.left - 1) * every));
      offset = Math.floor(offset / rhythm) * rhythm;
    }
    for (let i = 0; i < x.left; i++) out.push({ d: addD(start, offset + i * every), s: x.p.id, n: (x.p.from ?? 0) + i + 1 });
  });
  return out.sort((a, b) => (a.d === b.d ? 0 : a.d < b.d ? -1 : 1));
}

/** Visits: the plan grouped by day. */
export function planVisits(plan: PlanStep[]): { d: string; steps: PlanStep[] }[] {
  const by = new Map<string, PlanStep[]>();
  for (const st of plan) by.set(st.d, [...(by.get(st.d) ?? []), st]);
  return [...by.entries()].map(([d, steps]) => ({ d, steps }));
}

/** Short service names for the client's schedule: "Brilliant drip", "Signature facial". */
export const shortName = (name: string) => name.replace(/\s*\((?:single session|program)\)\s*$/i, "").replace(/\s+single session$/i, "").replace(/\s*·.*$/, "").trim();

/** Client-facing name for photos and captions (CHRIS Nov 27: never show internal Service log labels such as
 *  "Single Session", "(program)" or "Hifu Back Fat" in anything a client sees). */
const AD_WORDS: [RegExp, string][] = [
  [/\bhifu\b/gi, "HIFU"], [/\brf\b/gi, "RF"], [/\bbb\b/gi, "BB"], [/\bipl\b/gi, "IPL"],
  [/\bback fat\b/gi, "Back"], [/\blove handles?\b/gi, "Waist"], [/\btummy\b/gi, "Tummy"],
  [/\bunderarms\b/gi, "Underarm"], [/\bface and neck\b/gi, "Face & Neck"],
];
const DRIP = /\b(lux queen|illumina|brilliant|gluta)\b/i;
const BEST = /\b(lux queen|hiko|ultra ?v)\b/i;
export function adName(name: string): string {
  let n = shortName(name)
    .replace(/\s*\((?:[^)]*)\)\s*/g, " ")
    .replace(/\s+\d+\s*\+\s*\d+\b/g, "")
    .replace(/\b(single|solo|session|sessions|promo|package)\b/gi, "")
    .replace(/\s{2,}/g, " ").trim();
  for (const [re, to] of AD_WORDS) n = n.replace(re, to);
  if (/^diode\b/i.test(n) && !/laser/i.test(n)) n = n.replace(/^diode/i, "Diode Laser");
  if (DRIP.test(n) && !/\bdrip\b/i.test(n)) n = `${n} Drip`;
  // Title case words that came in lower case ("Signature facial" → "Signature Facial").
  n = n.replace(/\b([a-z])([a-z]+)/g, (_, a: string, b: string) => (/^(and|of|with|or)$/.test(a + b) ? a + b : a.toUpperCase() + b));
  return n || shortName(name);
}
/** "our best-selling Lux Queen Drip" for best sellers, otherwise just the name. */
export const adNameLong = (name: string) => (BEST.test(name) ? `our best-selling ${adName(name)}` : adName(name));

/** Shortest clear name for the client's schedule photo: "Facial", "HIFU face", "Carbon laser". */
export function tinyName(name: string): string {
  const n = shortName(name);
  if (/hifu.*(face|neck)/i.test(n)) return "HIFU face";
  if (/hifu/i.test(n)) return n.replace(/^hifu/i, "HIFU");
  if (/hydra/i.test(n)) return "Hydrafacial";
  if (/facial/i.test(n)) return "Facial";
  if (/carbon/i.test(n)) return "Carbon laser";
  if (/diode/i.test(n)) return "Diode laser";
  return adName(name);
}

/** Copy-paste text of a schedule for Messenger. */
export function scheduleText(p: { title: string; client: string; ends: string; plan: PlanStep[]; names: Record<string, string>; totals: Record<string, number> }) {
  const day = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-PH", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  const lines = planVisits(p.plan).map((v) => `${day(v.d)}: ${v.steps.map((s) => `${p.names[s.s] ? adName(p.names[s.s]) : "Session"} ${s.n} of ${p.totals[s.s] ?? s.n}`).join(" + ")}`);
  return [`${p.title}: your schedule`, p.client, `Use all sessions by ${day(p.ends)}.`, "", ...lines, "",
    "Message us a day before each visit to confirm your slot. You can move a date; just keep the spacing.", BRANCH_LINE].join("\n");
}

// ---------- Price justification (CHRIS Nov 27: every proposed price comes with its reasons) ----------
/** Per-session price of the client's existing packages for a service, e.g. Brilliant 10+3 at ₱10,000 → ₱769. */
export function packageRate(name: string, pkgs: Pkg[]): { name: string; perSession: number } | null {
  const want = baseName(name);
  let best: { name: string; perSession: number } | null = null;
  for (const p of pkgs) {
    const m = /^(.*?)\s+(\d+)\s*\+\s*(\d+)\s*$/.exec(p.name.trim());
    if (!m || m[1].trim().toLowerCase() !== want || !(p.total > 0)) continue;
    const per = Math.round(p.total / (Number(m[2]) + Number(m[3])));
    if (!best || per < best.perSession) best = { name: p.name.trim(), perSession: per };
  }
  return best;
}

/** What these sessions cost today at our CURRENT prices (CHRIS Nov 27: nobody buys at the single "regular" price): each
 *  service at its existing package's per-session price (e.g. Lux Queen 10+3), or its single price when it has no package.
 *  `basis` names the packages used, for "5% below your Lux Queen 10+3 price". */
export function currentValue(items: PromoItem[], pkgs: Pkg[] = []): { value: number; basis: string[]; single: string[] } {
  let value = 0; const basis: string[] = [], single: string[] = [];
  for (const it of items) {
    const pk = packageRate(it.name, pkgs);
    value += (pk ? pk.perSession : it.unit) * (it.paid + it.free);
    if (pk) basis.push(pk.name); else single.push(shortName(it.name));
  }
  return { value, basis, single };
}
/** "your Lux Queen 10+3 price", "your package prices", "single prices". */
export function basisText(c: { basis: string[]; single: string[] }): string {
  if (!c.basis.length) return "single prices";
  const pk = c.basis.length === 1 ? `your ${c.basis[0]} price` : "your package prices";
  return c.single.length ? `${pk} (single price for ${c.single.join(", ")})` : pk;
}
/** How far below today's prices a promo may go before it needs a second look: 15% against packages, 30% against singles. */
/** Short chip text: "5% below Lux Queen 10+3", "Same as packages", "8% below single prices". */
export function vsChip(off: number, basis: string): string {
  const b = basis.replace(/^your /, "").replace(/ price$/, "").replace(/ prices$/, "").replace(/ \(single price for .*\)$/, "");
  const pct = Math.abs(Math.round(off * 100));
  return pct < 1 ? `Same as ${b}` : `${pct}% ${off >= 0 ? "below" : "above"} ${b}`;
}
export const deepCut = (c: { basis: string[] }) => (c.basis.length ? 0.15 : 0.3);

export type Justification = {
  headline: string; lines: string[]; warnings: string[];
  value: number; off: number; commission: number; cost: number | null; margin: number | null;
  /** Value at current prices (packages where we have them) and the price's discount against it (negative = above). */
  current: number; basis: string; deep: boolean;
};
/** Why the price is what it is: against single prices, against your own packages, the commission it carries and the
 *  product cost (when set), plus the research or sales reason behind the idea. Shown in the builder and on the promo page. */
export function justify(items: PromoItem[], price: number, o: { pkgs?: Pkg[]; usual?: Record<string, number | null>; cost?: Record<string, number | null>; why?: string } = {}): Justification {
  const value = valueOf(items), n = sessionsOf(items);
  const cur = currentValue(items, o.pkgs ?? []);
  const off = cur.value > 0 ? 1 - price / cur.value : 0;
  const basis = basisText(cur);
  const lines: string[] = [], warnings: string[] = [];
  if (o.why) lines.push(`Why this idea: ${o.why}`);
  lines.push(`At ${basis}, these ${n} sessions come to ${peso(cur.value)}. ${peso(price)} is ${Math.abs(Math.round(off * 100))}% ${off >= 0 ? "below" : "above"} that${off >= 0 && off <= 0.1 && !isBundle(items) ? ", a small step down for a longer commitment" : ""}.`);
  for (const it of items) {
    const per = value > 0 ? Math.round((it.unit * Math.min(price, value)) / value) : 0;
    const pk = packageRate(it.name, o.pkgs ?? []);
    let t = `${shortName(it.name)}: ${peso(per)} per session here${pk ? "" : ` (single ${peso(it.unit)}, no package yet)`}`;
    if (pk) {
      const vs = per / pk.perSession - 1;
      t += `; your ${pk.name} is ${peso(pk.perSession)} per session, so this is ${Math.abs(Math.round(vs * 100))}% ${vs >= 0 ? "above" : "below"} it`;
      if (vs < -0.1) warnings.push(`${shortName(it.name)} is ${Math.round(-vs * 100)}% cheaper per session than your ${pk.name}. Clients may skip the package for this; keep the gap under 10% or add value instead of lowering the price.`);
    }
    lines.push(`${t}.`);
  }
  const comms = commissionsOf(items, price, o.usual ?? {});
  const commission = items.reduce((s, it, k) => s + comms[k] * (it.paid + it.free), 0);
  lines.push(`Staff commission if every session is used: ${peso(commission)} (${price > 0 ? ((commission / price) * 100).toFixed(1) : "0"}% of the price, the same 5% rule as your packages).`);
  const missing = items.filter((it) => o.cost?.[it.service_id] == null).map((it) => shortName(it.name));
  let cost: number | null = null, margin: number | null = null;
  if (!missing.length) {
    cost = items.reduce((s, it) => s + (o.cost![it.service_id] ?? 0) * (it.paid + it.free), 0);
    const left = price - commission - cost;
    margin = price > 0 ? left / price : null;
    lines.push(`Product cost for all sessions: about ${peso(cost)}. Left after commission and product: ${peso(left)} (${margin === null ? "–" : Math.round(margin * 100)}% of the price), before rent and salaries.`);
    if (margin !== null && margin < 0.35) warnings.push(`Only ${Math.round(margin * 100)}% is left after commission and product. Consider fewer free sessions or a higher price.`);
  } else {
    lines.push(`Product cost per session isn't set yet for ${missing.join(", ")}, so the true margin can't be shown. Type it on the promo's Clients and profit page.`);
  }
  const deep = off > deepCut(cur);
  if (deep) warnings.push(`${Math.round(off * 100)}% below ${basis}. That cuts into profit: try fewer free sessions, or a free add-on (like L-Carnitine) instead of a lower price.`);
  const vs = Math.abs(Math.round(off * 100)) < 1 ? `Same as ${basis}` : `${Math.abs(Math.round(off * 100))}% ${off >= 0 ? "below" : "above"} ${basis}`;
  const headline = `${vs} · ${peso(Math.round(price / Math.max(1, n)))} per session on average · commission ${peso(commission)}${margin !== null ? ` · about ${Math.round(margin * 100)}% left after commission and product` : ""}`;
  return { headline, lines, warnings, value, off, commission, cost, margin, current: cur.value, basis, deep };
}
