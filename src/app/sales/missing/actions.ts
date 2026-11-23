"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { phpToCents } from "@/lib/csv";
import { errorText } from "@/lib/access";

export type FillState = { error?: string; ok?: string } | undefined;

const Fill = z.object({
  branch: z.uuid(),
  date: z.iso.date(),
  mode: z.enum(["amount", "closed"]),
  amount: z.string().trim().max(20).optional(),
});

export async function fillDay(_prev: FillState, fd: FormData): Promise<FillState> {
  const p = Fill.safeParse({ branch: fd.get("branch"), date: fd.get("date"), mode: fd.get("mode"), amount: fd.get("amount") ?? undefined });
  if (!p.success) return { error: "Check the amount." };
  let cents: number | null = null;
  if (p.data.mode === "amount") {
    try {
      cents = phpToCents((p.data.amount ?? "").replace(/[,₱\s]/g, ""));
    } catch {
      return { error: "Enter the day's sales, e.g. 45200.50" };
    }
    if (cents <= 0) return { error: "Enter an amount above zero, or mark the day closed." };
  }
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fill_missing_day", {
    p_branch: p.data.branch, p_date: p.data.date, p_amount_cents: cents, p_closed: p.data.mode === "closed", p_note: null,
  });
  if (error) return { error: "Could not save. Try again." };
  if (!data.ok) return { error: errorText(data.error) };
  revalidatePath("/sales/missing");
  revalidatePath("/");
  if (data.state === "CLOSED") return { ok: "Marked closed" };
  if (data.state === "STAGED") return { ok: "Saved, waiting for sign-off" };
  return { ok: "Saved" };
}
