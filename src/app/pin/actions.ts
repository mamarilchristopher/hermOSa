"use server";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { errorText } from "@/lib/access";

export type PinState = { error?: string; n?: number } | undefined;

export async function verifyPin(prev: PinState, fd: FormData): Promise<PinState> {
  const n = (prev?.n ?? 0) + 1;
  const pin = String(fd.get("pin") ?? "").trim();
  if (!/^\d{4}$/.test(pin)) return { error: errorText("PIN_FORMAT"), n };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("verify_my_pin", { p_pin: pin });
  if (error) return { error: "Could not check the PIN. Try again.", n };
  if (!data.ok) {
    const left = data.tries_left as number | undefined;
    return { error: data.error === "PIN_WRONG" && left !== undefined ? `That PIN isn't right. ${left} ${left === 1 ? "try" : "tries"} left.` : errorText(data.error), n };
  }
  redirect("/");
}
