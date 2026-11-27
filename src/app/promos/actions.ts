"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { errorText } from "@/lib/access";

export type PromoResult = { ok?: string; error?: string; id?: string; service?: string };

const MSG: Record<string, string> = {
  BAD_TITLE: "Give the promo a title (3 to 80 letters).",
  BAD_COUNTS: "Each service needs 1 to 50 paid sessions and 0 to 50 free ones.",
  BAD_PRICE: "The promo price must be more than ₱0 and not more than the sessions are worth.",
  UNKNOWN_SERVICE: "One of the services isn't on the price list any more. Refresh the page.",
  NAME_TAKEN: "A Service log item with that name already exists. Change the title a little and approve again.",
  NOT_ALLOWED: "Only owners and the GM can save promos.",
  NOT_FOUND: "That promo was already approved or removed. Refresh the page.",
};
const fail = (error: { code?: string } | null, code?: string) =>
  error?.code === "PGRST202" || error?.code === "42P01" ? "The owner needs to run update-0086 in Supabase first." : error ? "Could not save. Try again." : (code && MSG[code]) || errorText(code);

const Input = z.object({
  id: z.uuid().nullable(),
  title: z.string().trim().min(3).max(80),
  tagline: z.string().trim().max(160),
  items: z.array(z.object({ service_id: z.uuid(), paid: z.number().int().min(1).max(50), free: z.number().int().min(0).max(50) })).min(1).max(8),
  price: z.number().int().positive(),
  months: z.number().int().min(1).max(24),
  endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  model: z.string().regex(/^M\d{2,3}$/).nullable(),
  source: z.enum(["MANUAL", "SUGGESTED"]),
  // update-0091: payment options
  pay: z.enum(["FULL", "INSTALLMENT"]).optional(),
  maxPay: z.number().int().min(2).max(6).nullable().optional(),
});
export type PromoInput = z.infer<typeof Input>;

async function save(input: PromoInput) {
  const p = Input.safeParse(input);
  if (!p.success) return { error: p.error.issues[0]?.path[0] === "title" ? MSG.BAD_TITLE : "Check the promo and try again." };
  const supabase = await createClient();
  const d = p.data;
  const { data, error } = await supabase.rpc("save_promo", {
    p_id: d.id, p_title: d.title, p_tagline: d.tagline, p_items: d.items, p_price_cents: d.price,
    p_valid_months: d.months, p_ends_on: d.endsOn, p_model: d.model, p_source: d.source,
  });
  if (error || !data?.ok) return { error: fail(error, data?.error) };
  // update-0091: full payment or installments (up to maxPay monthly payments).
  if (d.pay) {
    const { data: pr, error: prErr } = await supabase.rpc("set_promo_payment", { p_id: data.id, p_options: d.pay, p_max: d.pay === "INSTALLMENT" ? d.maxPay ?? null : null });
    if (prErr?.code === "PGRST202") { if (d.pay === "INSTALLMENT") return { error: "Installments need update-0091. Ask the owner to run it, or choose Full payment for now." }; }
    else if (prErr || !pr?.ok) return { error: "Could not save the payment option. Try again." };
  }
  return { supabase, id: data.id as string };
}

/** Save as a draft (owners and the GM; the database re-reads every price). */
export async function savePromo(input: PromoInput): Promise<PromoResult> {
  const r = await save(input);
  if ("error" in r) return { error: r.error };
  revalidatePath("/promos");
  return { ok: "Saved as a draft.", id: r.id };
}

/** Save, then approve: the promo becomes a Sales log item on the price list and management is told. */
export async function approvePromo(input: PromoInput): Promise<PromoResult> {
  const r = await save(input);
  if ("error" in r) return { error: r.error };
  const { data, error } = await r.supabase.rpc("approve_promo", { p_id: r.id });
  if (error || !data?.ok) return { error: fail(error, data?.error), id: r.id };
  revalidatePath("/promos"); revalidatePath("/services"); revalidatePath("/services/prices");
  revalidatePath(`/promos/${r.id}`);
  // update-0087: set up per service with scaled commission; before it, one item.
  if (Array.isArray(data.parts)) return { ok: `Approved. It's in the Service log under Promos (${data.parts.length === 1 ? "1 item" : `${data.parts.length} items and a payment line`}). When a client buys it, log their first visit with "New client" to start their schedule.`, id: r.id };
  return { ok: `Approved. "${data.service}" is now on the Service log.`, id: r.id, service: data.service };
}

/** Delete a draft, or end an approved promo (its Service log item is hidden). */
export async function endPromo(id: string): Promise<PromoResult> {
  const p = z.uuid().safeParse(id);
  if (!p.success) return { error: "Refresh the page and try again." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("end_promo", { p_id: p.data });
  if (error || !data?.ok) return { error: fail(error, data?.error) };
  revalidatePath("/promos"); revalidatePath("/services"); revalidatePath("/services/prices");
  if (data.deleted) return { ok: "Draft deleted." };
  return { ok: data.active_clients ? `Promo ended: no new clients. ${data.active_clients} client${data.active_clients === 1 ? " still has" : "s still have"} sessions left, so its items stay in the Service log until they finish.` : "Promo ended. Its Service log items are hidden." };
}

// ---------- update-0087: client promos and product costs ----------
const TRACK_MSG: Record<string, string> = {
  NOT_ALLOWED: "Only owners and the GM can do that.",
  PROMO_CLIENT_CLOSED: "This client's promo is already finished or cancelled.",
  NOT_FOUND: "That client's promo wasn't found. Refresh the page.",
};
const trackFail = (error: { code?: string } | null, code?: string) =>
  error?.code === "PGRST202" || error?.code === "42P01" ? "The owner needs to run update-0087 in Supabase first." : error ? "Could not save. Try again." : (code && TRACK_MSG[code]) || errorText(code);

const Step = z.object({ d: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), s: z.uuid(), n: z.number().int().min(1).max(100) });

/** SCHEDULE (a new plan), CONTACT, EXTEND (months), CANCEL or REOPEN a client's promo. */
export async function updatePromoClient(id: string, action: "SCHEDULE" | "CONTACT" | "EXTEND" | "CANCEL" | "REOPEN", opts: { schedule?: unknown; months?: number; contact?: string } = {}): Promise<PromoResult> {
  if (!z.uuid().safeParse(id).success) return { error: "Try again." };
  const schedule = opts.schedule === undefined ? null : z.array(Step).max(400).safeParse(opts.schedule);
  if (schedule && !schedule.success) return { error: "That schedule didn't look right. Try again." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("update_promo_client", {
    p_id: id, p_action: action, p_schedule: schedule?.data ?? null, p_months: opts.months ?? null, p_contact: opts.contact ?? null,
  });
  if (error || !data?.ok) return { error: trackFail(error, data?.error) };
  revalidatePath(`/promos/client/${id}`);
  revalidatePath("/promos");
  return { ok: action === "SCHEDULE" ? "Schedule saved." : action === "EXTEND" ? `Extended by ${opts.months} month${opts.months === 1 ? "" : "s"}.` : action === "CANCEL" ? "Cancelled. Their remaining sessions are closed." : action === "REOPEN" ? "Reopened." : "Saved." };
}

/** Product cost of one session of a service (owners and the GM), for the promo profit. */
export async function setServiceCost(serviceId: string, pesos: string, promoId: string): Promise<PromoResult> {
  if (!z.uuid().safeParse(serviceId).success) return { error: "Try again." };
  const t = pesos.replace(/[,₱\s]/g, "");
  const cents = t === "" ? null : Math.round(Number(t) * 100);
  if (cents !== null && !(cents >= 0 && cents <= 100000000)) return { error: "Type the cost in pesos, e.g. 450." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("set_service_cost", { p_service: serviceId, p_cost_cents: cents });
  if (error || !data?.ok) return { error: trackFail(error, data?.error) };
  revalidatePath(`/promos/${promoId}`);
  return { ok: "Cost saved." };
}
