/**
 * Promo tracking (update-0087, CHRIS Nov 27): each client who buys an approved promo, their schedule, the sessions done,
 * and the promo's running profit. Pure functions, shared by the Service log, the tracker and the schedule pages.
 */
import { promoSchedule, shortName, type PlanStep } from "./promoRules";

export type PromoPart = { service_id: string; base_id: string; name: string; sessions: number; unit_cents: number; commission_cents: number };
export type PromoOpt = { id: string; title: string; state: "APPROVED" | "ENDED" | "DRAFT"; months: number; price_cents: number; pay_service_id: string | null; parts: PromoPart[] };
export type PromoClientOpt = {
  id: string; promo_id: string; client: string; branch_id: string; start_on: string; ends_on: string;
  price_cents: number; paid_cents: number; used: Record<string, number>;
};
export type PromoOptions = { promos: PromoOpt[]; clients: PromoClientOpt[] };

/** Which promo a Service log item belongs to, and whether it's a session or the payment line. */
export function promoOf(serviceId: string, o: PromoOptions | null | undefined) {
  for (const p of o?.promos ?? []) {
    if (p.pay_service_id === serviceId) return { promo: p, part: null, pay: true };
    const part = p.parts.find((x) => x.service_id === serviceId);
    if (part) return { promo: p, part, pay: false };
  }
  return null;
}
export const promoServiceIds = (o: PromoOptions | null | undefined) =>
  new Set((o?.promos ?? []).flatMap((p) => [...p.parts.map((x) => x.service_id), ...(p.pay_service_id ? [p.pay_service_id] : [])]));
/** "Glow Year: Brilliant", "Glow Year: payment", "Sculpt Sprint: Hifu Arms 3+1". */
export function promoItemLabel(serviceId: string, o: PromoOptions | null | undefined) {
  const m = promoOf(serviceId, o);
  if (!m) return null;
  if (m.pay) return `${m.promo.title}: payment`;
  const p = m.part!;
  return m.promo.pay_service_id ? `${m.promo.title}: ${shortName(p.name)}` : `${m.promo.title}: ${shortName(p.name)} (${p.sessions} sessions)`;
}

/** The plan for a new client starting today. */
export const firstPlan = (p: PromoOpt, start: string): PlanStep[] =>
  promoSchedule(p.parts.map((x) => ({ id: x.service_id, name: x.name, sessions: x.sessions })), start, p.months);

/** Sessions done per item (service id → count). */
export type Log = { service_id: string; date: string; n: number; amount_cents: number };
export function doneCount(logs: Log[]) {
  const m: Record<string, number> = {};
  for (const l of logs) m[l.service_id] = (m[l.service_id] ?? 0) + 1;
  return m;
}

/** Each planned session marked done (with the day it was done) or not. */
export function planStatus(plan: PlanStep[], logs: Log[]) {
  const byItem = new Map<string, Log[]>();
  for (const l of [...logs].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.n - b.n))) byItem.set(l.service_id, [...(byItem.get(l.service_id) ?? []), l]);
  return plan.map((st) => {
    const done = byItem.get(st.s)?.[st.n - 1];
    return { ...st, doneOn: done?.date ?? null };
  });
}

/** The next session not yet done, and whether the client is behind (a planned date more than a week ago). */
export function nextDue(plan: PlanStep[], logs: Log[], today: string) {
  const st = planStatus(plan, logs).find((x) => !x.doneOn);
  if (!st) return null;
  const late = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${st.d}T00:00:00Z`)) / 86400000);
  return { ...st, late, overdue: late > 7, due: late >= 0 };
}

/** The rest of the plan from a new date (sessions already done stay as they are). */
export function replan(parts: PromoPart[], logs: Log[], from: string, end: string): PlanStep[] {
  const done = doneCount(logs);
  return promoSchedule(parts.map((x) => ({ id: x.service_id, name: x.name, sessions: x.sessions, from: Math.min(x.sessions, done[x.service_id] ?? 0) })), from, 1, end);
}

/** A promo's running numbers. Costs per session come from the usual service (services.cost_cents), when set. */
export type ClientRow = { id: string; state: "ACTIVE" | "DONE" | "CANCELLED"; price_cents: number };
export type LogRow = { promo_client_id: string; service_id: string; amount_paid_cents: number; commission_cents: number };
export function promoMoney(parts: PromoPart[], clients: ClientRow[], logs: LogRow[], cost: Record<string, number | null>, price: number) {
  const live = clients.filter((c) => c.state !== "CANCELLED");
  const sold = live.reduce((s, c) => s + Number(c.price_cents), 0);
  const collected = logs.reduce((s, l) => s + Number(l.amount_paid_cents), 0);
  const commissionPaid = logs.reduce((s, l) => s + Number(l.commission_cents), 0);
  const value = parts.reduce((s, p) => s + p.unit_cents * p.sessions, 0);
  const rows = parts.map((p) => {
    const done = logs.filter((l) => l.service_id === p.service_id).length;
    // Sessions still owed: active clients only (a finished or cancelled promo owes nothing more).
    const owed = clients.filter((c) => c.state === "ACTIVE").reduce((s, c) => s + Math.max(0, p.sessions - logs.filter((l) => l.promo_client_id === c.id && l.service_id === p.service_id).length), 0);
    const c = cost[p.base_id];
    const perSession = value > 0 ? Math.round((p.unit_cents * Math.min(price, value)) / value) : 0;
    return { ...p, done, owed, cost: c ?? null, perSession, earned: done * perSession };
  });
  const commissionOwed = rows.reduce((s, r) => s + r.owed * r.commission_cents, 0);
  const costsKnown = rows.every((r) => r.cost !== null);
  const costDone = rows.reduce((s, r) => s + r.done * (r.cost ?? 0), 0);
  const costOwed = rows.reduce((s, r) => s + r.owed * (r.cost ?? 0), 0);
  const earned = rows.reduce((s, r) => s + r.earned, 0);
  const profitNow = collected - commissionPaid - costDone;
  const profitEnd = sold - commissionPaid - commissionOwed - costDone - costOwed;
  return {
    rows, sold, collected, balance: Math.max(0, sold - collected), commissionPaid, commissionOwed, costsKnown, costDone, costOwed,
    earned, unearned: Math.max(0, collected - earned), profitNow, profitEnd, margin: sold > 0 ? profitEnd / sold : null,
    clients: { active: clients.filter((c) => c.state === "ACTIVE").length, done: clients.filter((c) => c.state === "DONE").length, cancelled: clients.filter((c) => c.state === "CANCELLED").length },
  };
}
