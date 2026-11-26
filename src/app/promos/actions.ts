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
  return { ok: data.deleted ? "Draft deleted." : "Promo ended. Its Service log item is hidden." };
}
