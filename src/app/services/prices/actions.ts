"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { errorText } from "@/lib/access";

export type PriceState = { ok?: string; error?: string; n?: number } | undefined;

const cents = (v: FormDataEntryValue | null): number | null | "bad" => {
  const t = String(v ?? "").replace(/[,₱\s]/g, "");
  if (!t) return null;
  return /^\d+(\.\d{1,2})?$/.test(t) ? Math.round(Number(t) * 100) : "bad";
};

/** Add (no id) or change a service, its price and its commission. Owners and the GM (the database checks). */
export async function saveService(prev: PriceState, fd: FormData): Promise<PriceState> {
  const n = (prev?.n ?? 0) + 1;
  const idRaw = String(fd.get("id") ?? "");
  const id = idRaw ? z.uuid().safeParse(idRaw) : null;
  if (id && !id.success) return { error: "Refresh the page and try again.", n };
  const name = String(fd.get("name") ?? "").trim();
  const price = cents(fd.get("price")), commission = cents(fd.get("commission"));
  if (name.length < 2) return { error: "Type the service name.", n };
  if (price === "bad" || commission === "bad") return { error: "Prices are peso amounts, like 8999.", n };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("save_service", {
    p_id: id?.data ?? null, p_name: name, p_price_cents: price, p_commission_cents: commission, p_active: fd.get("active") !== "off",
  });
  if (error) return { error: error.code === "PGRST202" ? "The owner needs to run update-0042 in Supabase first." : "Could not save. Try again.", n };
  if (!data?.ok) return { error: errorText(data?.error), n };
  revalidatePath("/services/prices"); revalidatePath("/services"); revalidatePath("/bookings");
  return { ok: id ? "Saved." : `Added "${name}".`, n };
}

/** Mark a service as an add-on (update-0080), or not. Owners and the GM (the database checks). */
export async function setAddon(_prev: PriceState, fd: FormData): Promise<PriceState> {
  const id = z.uuid().safeParse(String(fd.get("id") ?? ""));
  if (!id.success) return { error: "Refresh the page and try again." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("set_service_addon", { p_id: id.data, p_on: fd.get("on") === "1" });
  if (error) return { error: error.code === "PGRST202" ? "The owner needs to run update-0080 in Supabase first." : "Could not save. Try again." };
  if (!data?.ok) return { error: errorText(data?.error) };
  revalidatePath("/services/prices"); revalidatePath("/services");
  return { ok: "Saved." };
}
