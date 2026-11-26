/**
 * Promo generator rules (CHRIS Nov 27): repeat-safety per service, pricing math, PH seasons, captions and the
 * Monday suggestions. Shared by the Promos page (server) and the builder (browser).
 * Never show a "regular price" on any material (CHRIS Nov 24): images and captions show only the promo price,
 * the session count and the price per session.
 */

// ---------- Repeat safety ----------
export type Safety = { gapDays: number; maxYear: number; bundleOk: boolean; note: string };

const SAFETY: [RegExp, Safety][] = [
  [/hiko|thread|diamond tip|fox eye|hexalift|v ?lift|mono/i, { gapDays: 180, maxYear: 2, bundleOk: false, note: "Thread lifts are one procedure with touch-ups, not repeat sessions." }],
  [/filler/i, { gapDays: 180, maxYear: 2, bundleOk: false, note: "Fillers last 6 to 12 months; not for repeat bundles." }],
  [/microshading|lip blush/i, { gapDays: 30, maxYear: 2, bundleOk: false, note: "Brows and lips are one procedure plus one touch-up." }],
  [/wart|skin ?tag/i, { gapDays: 30, maxYear: 2, bundleOk: false, note: "Removal is a one-off treatment." }],
  [/novoform/i, { gapDays: 7, maxYear: 52, bundleOk: false, note: "Novoform is doctor-guided; keep it out of promos." }],
  [/barbie/i, { gapDays: 14, maxYear: 3, bundleOk: false, note: "Barbie Arms is already a 3-dose treatment." }],
  [/botox|jawtox|sweatox|alar/i, { gapDays: 90, maxYear: 4, bundleOk: true, note: "Botox at least 3 months apart (4 a year at most)." }],
  [/hifu face|hifu.*neck/i, { gapDays: 180, maxYear: 2, bundleOk: true, note: "Face HIFU at least 6 months apart." }],
  [/hifu/i, { gapDays: 30, maxYear: 6, bundleOk: true, note: "Body HIFU about a month apart." }],
  [/carbon/i, { gapDays: 14, maxYear: 24, bundleOk: true, note: "Carbon laser every 2 to 4 weeks." }],
  [/diode/i, { gapDays: 28, maxYear: 12, bundleOk: true, note: "Diode every 4 to 6 weeks (8 to 10 sessions is a full course)." }],
  [/mesolipo|lemon bottle/i, { gapDays: 7, maxYear: 12, bundleOk: true, note: "Fat dissolving weekly to every 2 weeks, about 6 to 10 sessions." }],
  [/v ?contour|\brf\b/i, { gapDays: 7, maxYear: 24, bundleOk: true, note: "Weekly sessions are fine." }],
  [/lux queen|illumina|brilliant|gluta|l-carnitine/i, { gapDays: 7, maxYear: 52, bundleOk: true, note: "Drips weekly to monthly." }],
  [/bb glow/i, { gapDays: 14, maxYear: 12, bundleOk: true, note: "BB Glow every 2 to 4 weeks." }],
  [/facial|peel|acne|hydra|kanolone|pdt|whitening/i, { gapDays: 14, maxYear: 26, bundleOk: true, note: "Facials every 2 to 4 weeks." }],
];
const DEFAULT_SAFETY: Safety = { gapDays: 14, maxYear: 12, bundleOk: true, note: "Check the spacing with the clinic doctor." };

export const safetyFor = (name: string): Safety => SAFETY.find(([re]) => re.test(name))?.[1] ?? DEFAULT_SAFETY;

export type PromoItem = { service_id: string; name: string; unit: number; paid: number; free: number };

/** Problems with a bundle for the client's safety: not repeat-safe, or too many sessions for the time allowed. */
export function safetyIssues(items: PromoItem[], months: number): string[] {
  const out: string[] = [];
  for (const it of items) {
    const s = safetyFor(it.name), n = it.paid + it.free;
    if (!s.bundleOk && n > 1) { out.push(`${it.name}: ${s.note}`); continue; }
    const allowed = Math.max(1, Math.floor((s.maxYear * months) / 12));
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
export const defaultPrice = (items: PromoItem[]) => (isBundle(items) ? paidValueOf(items) : nicePrice(Math.round(paidValueOf(items) * 0.8)));

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
  { key: "1212", name: "12.12 sale", from: [12, 5], to: [12, 12], angle: "One-day 12.12 deal, prepaid", fits: /hifu|diode|carbon|facial|gluta|v ?contour|mesolipo/i },
  { key: "newyear", name: "New Year, New Me", from: [12, 26], to: [1, 20], angle: "A whole year of glow, paid once", fits: /hifu|v ?contour|mesolipo|lemon bottle|rf|facial|carbon|gluta/i },
  { key: "valentine", name: "Valentine's", from: [1, 25], to: [2, 14], angle: "Glow together: couples and best friends", fits: /facial|hydra|gluta|lip|carbon|bb glow|botox/i },
  { key: "summer", name: "Summer body", from: [3, 1], to: [5, 31], angle: "Arms, underarms and tummy ready for the beach", fits: /diode|underarm|\bua\b|hifu (arms|tummy|back)|mesolipo|lemon bottle|v ?contour|sweatox|whitening/i },
  { key: "grad", name: "Graduation and prom", from: [3, 15], to: [4, 30], angle: "Photo-ready for the big day", fits: /facial|hydra|carbon|bb glow|gluta|acne/i },
  { key: "mothers", name: "Mother's Day", from: [4, 25], to: [5, 12], angle: "Treat Mom: book together", fits: /facial|hydra|gluta|rf|hifu face|botox/i },
  { key: "rainy", name: "Rainy season skin care", from: [6, 1], to: [8, 31], angle: "Keep skin clear through the rainy months", fits: /acne|facial|peel|hydra|carbon|kanolone/i },
  { key: "school", name: "Back to school", from: [7, 15], to: [8, 31], angle: "Clear skin for the new school year", fits: /acne|facial|carbon|diode/i },
  { key: "saledays", name: "9.9, 10.10 and 11.11 sale days", from: [9, 1], to: [11, 11], angle: "Double-day sale: prepay and save", fits: /hifu|diode|carbon|facial|gluta|v ?contour/i },
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
  [/hifu (arms|tummy|back)|mesolipo|lemon bottle|v ?contour|\brf body/i, ["Snatched by Summer", "The Sculpt Sprint", "Tight & Toned Pass", "Body Goals Bundle"]],
  [/hifu/i, ["Lifted Look Pass", "The Contour Club", "V-Line Season"]],
  [/diode|underarm|\bua\b|whitening|sweatox/i, ["Smooth Season Pass", "Bare & Bright", "Sleeveless Season", "Forever Smooth"]],
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

/** Paid + free counts that are safe and attractive for a service: weekly services get 5+2, monthly 5+1, slower 3+1. */
function countsFor(name: string): [number, number] {
  const s = safetyFor(name);
  if (s.gapDays <= 7) return [5, 2];
  if (s.gapDays <= 14) return [5, 1];
  if (s.gapDays <= 30) return [3, 1];
  return [2, 0];
}

const PROGRAMS: { title: string; tagline: string; months: number; parts: [RegExp, number][] }[] = [
  { title: "Hermosa Black Card", tagline: "A full year of glow, paid once", months: 12, parts: [[/^signature facial$/i, 12], [/^carbon laser face$/i, 6], [/^lux queen single/i, 6], [/^hifu face and neck$/i, 2]] },
  { title: "Glow Year Club", tagline: "Your monthly glow, sorted for the year", months: 12, parts: [[/^signature facial$/i, 12], [/^glass skin hydrafacial$/i, 6], [/^lux queen single/i, 6]] },
  { title: "Sculpt Season Pass", tagline: "Six months to your summer body", months: 6, parts: [[/^v ?contour$/i, 12], [/^mesolipo arms/i, 6]] },
  { title: "Forever Smooth Pass", tagline: "Smooth underarms all year", months: 12, parts: [[/^diode underarms$/i, 10]] },
];

export function suggest(stats: SvcStat[], today: string): Suggestion[] {
  const out: Suggestion[] = [];
  const usable = stats.filter((s) => s.price > 0 && safetyFor(s.name).bundleOk && !/test service|single session.*double|double dose/i.test(s.name));
  const mk = (s: SvcStat, kind: Suggestion["kind"], why: string, season?: Season): Suggestion => {
    const [paid, free] = countsFor(s.name);
    const items = [{ service_id: s.id, name: s.name, unit: s.price, paid, free }];
    const months = Math.max(1, Math.min(12, Math.ceil(((paid + free) * safetyFor(s.name).gapDays) / 30) + 1));
    const title = titleIdeas(items, season)[0];
    return { id: `${kind}-${s.id}-${season?.key ?? ""}`, kind, why, title, tagline: season?.angle ?? `${s.name}: more sessions, better results`, items, price: defaultPrice(items), months, season: season?.name };
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
  // 3. One year-long program each week (rotates by week number), priced from today's price list.
  const week = Math.floor(new Date(`${today}T00:00:00Z`).getTime() / (7 * 86400000));
  for (let k = 0; k < PROGRAMS.length; k++) {
    const pr = PROGRAMS[(week + k) % PROGRAMS.length];
    const items: PromoItem[] = [];
    for (const [re, n] of pr.parts) { const s = stats.find((x) => re.test(x.name) && x.price > 0); if (s) items.push({ service_id: s.id, name: s.name, unit: s.price, paid: n, free: 0 }); }
    if (items.length !== pr.parts.length) continue;
    out.push({ id: `PROGRAM-${pr.title}`, kind: "PROGRAM", why: "Prepaid for the year: cash today, and clients keep coming back to you instead of other clinics.", title: pr.title, tagline: pr.tagline, items, price: defaultPrice(items), months: pr.months });
    break;
  }
  return out;
}
