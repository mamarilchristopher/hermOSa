/**
 * Promo payments and posting (update-0091, CHRIS Nov 27): full payment upfront or monthly installments, the posting
 * calendar, the pricing card CSRs copy for inquiries and the All staff announcement. Pure functions, shared by the
 * builder, the Service log, the tracker and the posting page.
 */
import { addD, addM, adName, adNameLong, BRANCH_LINE, mechanic, peso, sessionsOf, type PromoItem } from "./promoRules";

export type PayOptions = "FULL" | "INSTALLMENT";

/** Recommended installment plans by promo price (CHRIS Nov 27, same total, no interest):
 *  under ₱10,000 full payment only; ₱10,000 to ₱29,999 two or three monthly payments; ₱30,000 and up up to six. */
export function installmentPlans(price: number): { allowed: number[]; recommended: number | null; why: string } {
  if (price < 1000000) return { allowed: [], recommended: null, why: "Under ₱10,000: full payment only, so small promos stay simple to collect." };
  if (price < 3000000) return { allowed: [2, 3], recommended: 3, why: "₱10,000 to ₱29,999: 2 or 3 monthly payments keeps each payment near a single-session price." };
  return { allowed: [2, 3, 4, 6], recommended: 6, why: "₱30,000 and up: up to 6 monthly payments, so a year program costs about one facial a month." };
}

/** The payments of an n-payment plan, in whole pesos, the extra centavos on the first. Due monthly from the start. */
export function planDues(price: number, n: number, start: string): { k: number; due: string; amount: number }[] {
  const k = Math.max(1, Math.min(6, Math.round(n)));
  const each = Math.floor(price / k / 100) * 100;
  return Array.from({ length: k }, (_, i) => ({ k: i + 1, due: addM(start, i), amount: i === 0 ? price - each * (k - 1) : each }));
}

/** Sessions a client may use for what they've paid (each payment unlocks its share). Mirrors log_promo_visit. */
export const sessionsUnlocked = (total: number, paid: number, price: number) =>
  price <= 0 ? total : Math.min(total, Math.floor((total * Math.max(0, paid)) / price));

/** What a client still has to pay before their next session can be logged. */
export const payToUnlock = (total: number, used: number, paid: number, price: number) =>
  used >= total ? 0 : Math.max(0, Math.ceil((price * (used + 1)) / total) - paid);

/** Where a client stands on their plan today: the next payment due, and whether it's late. */
export function payStatus(price: number, payments: number, start: string, paid: number, today: string) {
  const dues = planDues(price, payments, start);
  let owedByNow = 0, next: { k: number; due: string; amount: number } | null = null, cum = 0;
  for (const d of dues) {
    cum += d.amount;
    if (d.due <= today) owedByNow = cum;
    if (!next && cum > paid) next = { ...d, amount: Math.min(d.amount, cum - paid) };
  }
  const behind = Math.max(0, owedByNow - paid);
  return { dues, next, behind, balance: Math.max(0, price - paid), late: behind > 0 };
}

const longDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-PH", { month: "long", day: "numeric", timeZone: "UTC" });
const shortDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-PH", { month: "short", day: "numeric", timeZone: "UTC" });

/** "₱18,999 in full, or 3 monthly payments of ₱6,333". */
export function payLine(price: number, pay: PayOptions | null | undefined, max: number | null | undefined) {
  if (pay !== "INSTALLMENT" || !max || max < 2) return `${peso(price)} in full`;
  const d = planDues(price, max, "2000-01-01");
  return `${peso(price)} in full, or ${max} monthly payments of ${peso(d[1].amount)}${d[0].amount !== d[1].amount ? ` (first ${peso(d[0].amount)})` : ""}`;
}

// ---------- Posting calendar ----------
export type PostSlot = "LAUNCH" | "REMINDER" | "LAST_DAYS" | "LAST_DAY";
export const SLOT_LABEL: Record<PostSlot, string> = { LAUNCH: "Launch", REMINDER: "Reminder", LAST_DAYS: "Last 3 days", LAST_DAY: "Last day" };
export type CalendarRow = { slot: PostSlot; due_on: string; feed: boolean; story: boolean; badge: string | null };

/** When to post (CHRIS Nov 27): launch day = FB feed + Story on all 4 pages; then Stories only (the daily 12 PM feed
 *  post already runs): a reminder halfway, "Last 3 days" and "Last day". No end date = a reminder after a week. */
export function postingCalendar(start: string, endsOn?: string | null): CalendarRow[] {
  const rows: CalendarRow[] = [{ slot: "LAUNCH", due_on: start, feed: true, story: true, badge: null }];
  const days = endsOn ? Math.round((Date.parse(`${endsOn}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) : null;
  if (days === null) { rows.push({ slot: "REMINDER", due_on: addD(start, 7), feed: false, story: true, badge: null }); return rows; }
  if (days >= 8) rows.push({ slot: "REMINDER", due_on: addD(start, Math.floor(days / 2)), feed: false, story: true, badge: null });
  if (days >= 4) rows.push({ slot: "LAST_DAYS", due_on: addD(endsOn!, -2), feed: false, story: true, badge: "LAST 3 DAYS" });
  if (days >= 1) rows.push({ slot: "LAST_DAY", due_on: endsOn!, feed: false, story: true, badge: "LAST DAY TODAY" });
  return rows;
}

// ---------- Texts ----------
type P = { title: string; tagline?: string; items: PromoItem[]; price: number; months: number; endsOn?: string | null; pay?: PayOptions | null; maxPayments?: number | null };

/** The offer in client words: "10 + 3 FREE sessions of our best-selling Lux Queen Drip" or the program list. */
function offer(p: P) {
  return p.items.length === 1
    ? `${p.items[0].paid}${p.items[0].free ? ` + ${p.items[0].free} FREE` : ""} sessions of ${adNameLong(p.items[0].name)}`
    : p.items.map((i) => `${i.paid + i.free} × ${adName(i.name)}`).join("\n• ");
}

/** The pricing card CSRs copy when a client asks (client-facing words only, never a regular price). */
export function pricingText(p: P) {
  const n = sessionsOf(p.items);
  const per = peso(Math.round(p.price / Math.max(1, n)));
  const plan = p.pay === "INSTALLMENT" && p.maxPayments && p.maxPayments >= 2 ? planDues(p.price, p.maxPayments, "2000-01-01") : null;
  return [
    `${p.title} ✨`,
    p.items.length === 1 ? offer(p) : `What's inside:\n• ${offer(p)}`,
    "",
    `💛 ${peso(p.price)} for ${n} sessions (${per} per session)`,
    plan ? `💳 Pay in full, or in ${plan.length} monthly payments: ${peso(plan[0].amount)} on your first visit, then ${peso(plan[1].amount)} every month after. Your sessions follow your payments.` : "💳 Full payment on your first visit",
    `🗓️ Use within ${p.months} month${p.months === 1 ? "" : "s"}`,
    p.endsOn ? `⏳ Promo runs until ${longDay(p.endsOn)}` : "⏳ Limited slots",
    `📍 ${BRANCH_LINE}`,
    "Send us your preferred branch, date and time and we'll book your slot 😊",
  ].join("\n");
}

/** A story caption for a reminder slot. */
export function slotStoryCaption(slot: PostSlot, base: string) {
  if (slot === "LAST_DAYS") return `LAST 3 DAYS ⏳\n${base}`;
  if (slot === "LAST_DAY") return `LAST DAY TODAY ⏳\n${base}`;
  if (slot === "REMINDER") return `Still on! 💛\n${base}`;
  return base;
}

/** The All staff announcement, sent once the launch posts are up. */
export function announceText(p: P & { serviceLog: string }) {
  const n = sessionsOf(p.items);
  const what = p.items.length === 1 ? `${mechanic(p.items)}${p.items[0].free ? "" : " sessions of"} ${adName(p.items[0].name)}`.replace(/FREE (.)/, "FREE $1") : `${n} sessions: ${p.items.map((i) => `${i.paid + i.free} × ${adName(i.name)}`).join(", ")}`;
  const plan = p.pay === "INSTALLMENT" && p.maxPayments && p.maxPayments >= 2 ? planDues(p.price, p.maxPayments, "2000-01-01") : null;
  return [
    `📣 NEW PROMO: ${p.title}`,
    "Now posted on all 4 pages (FB feed + Story). Please share it and offer it to every client today!",
    "",
    `• ${what}`,
    `• ${peso(p.price)} (${peso(Math.round(p.price / Math.max(1, n)))} per session)`,
    plan ? `• Payment: full, or up to ${plan.length} monthly payments of ${peso(plan[1].amount)}. Sessions follow payments.` : "• Payment: full on the first visit",
    `• Use within ${p.months} month${p.months === 1 ? "" : "s"}${p.endsOn ? ` · promo until ${shortDay(p.endsOn)}` : ""}`,
    "",
    `Service log: ${p.serviceLog}`,
  ].join("\n");
}

/** How staff log it, for the announcement. */
export const serviceLogHow = (title: string, installment: boolean) => installment
  ? `pick "${title} · payment" under Promos and log what the client paid (choose "New client" and their plan on the first visit), then log each session on its ${title} item.`
  : `pick the ${title} item under Promos. On the client's first visit choose "New client".`;
