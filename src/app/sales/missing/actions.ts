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
  mode: z.enum(["amount", "CLOSED", "NO_SALES"]),
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
    p_branch: p.data.branch, p_date: p.data.date, p_kind: p.data.mode === "amount" ? "AMOUNT" : p.data.mode,
    p_amount_cents: cents, p_note: null,
  });
  if (error) return { error: "Could not save. Try again." };
  if (!data.ok) return { error: errorText(data.error) };
  revalidatePath("/sales/missing");
  revalidatePath("/");
  if (data.state === "PENDING") return { ok: `Marked ${p.data.mode === "CLOSED" ? "closed" : "no sales"}, waiting for a second person to confirm` };
  if (data.state === "STAGED") return { ok: "Saved, waiting for sign-off" };
  return { ok: "Saved" };
}

const Decide = z.object({ mark: z.uuid(), decision: z.enum(["confirm", "reject"]) });

export async function decideDay(_prev: FillState, fd: FormData): Promise<FillState> {
  const p = Decide.safeParse({ mark: fd.get("mark"), decision: fd.get("decision") });
  if (!p.success) return { error: "Try again." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("decide_zero_day", { p_mark: p.data.mark, p_confirm: p.data.decision === "confirm", p_note: null });
  if (error) return { error: "Could not save. Try again." };
  if (!data.ok) return { error: errorText(data.error) };
  revalidatePath("/sales/missing");
  revalidatePath("/");
  return { ok: data.state === "CONFIRMED" ? "Confirmed" : "Rejected, the day is open again" };
}
