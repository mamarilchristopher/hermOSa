"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
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
  if (data.state === "CONFIRMED") return { ok: `Marked ${p.data.mode === "CLOSED" ? "closed" : "no sales"}` };
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

const Bulk = z.object({ kind: z.enum(["CLOSED", "NO_SALES"]), days: z.array(z.string().regex(/^[0-9a-f-]{36}\|\d{4}-\d{2}-\d{2}$/)).min(1).max(400) });

/** Mark several ticked days at once. Each still needs a second person to confirm. */
export async function bulkMark(fd: FormData) {
  const p = Bulk.safeParse({ kind: fd.get("kind"), days: fd.getAll("days") });
  const back = String(fd.get("back") ?? "/sales/missing");
  const safeBack = back.startsWith("/sales/missing") ? back : "/sales/missing";
  if (!p.success) redirect(`${safeBack}${safeBack.includes("?") ? "&" : "?"}msg=none`);
  const supabase = await createClient();
  let ok = 0, failed = 0;
  for (const item of p.data.days) {
    const [branch, date] = item.split("|");
    const { data } = await supabase.rpc("fill_missing_day", { p_branch: branch, p_date: date, p_kind: p.data.kind, p_amount_cents: null, p_note: null });
    if (data?.ok) ok++; else failed++;
  }
  revalidatePath("/sales/missing");
  revalidatePath("/");
  redirect(`${safeBack}${safeBack.includes("?") ? "&" : "?"}msg=marked-${ok}-${failed}`);
}

/** Second person confirms several pending marks at once (never their own; the database checks). */
export async function bulkConfirm(fd: FormData) {
  const ids = fd.getAll("marks").map(String).filter((x) => z.uuid().safeParse(x).success).slice(0, 400);
  const back = String(fd.get("back") ?? "/sales/missing");
  const safeBack = back.startsWith("/sales/missing") ? back : "/sales/missing";
  const supabase = await createClient();
  let ok = 0, failed = 0;
  for (const id of ids) {
    const { data } = await supabase.rpc("decide_zero_day", { p_mark: id, p_confirm: true, p_note: null });
    if (data?.ok) ok++; else failed++;
  }
  revalidatePath("/sales/missing");
  revalidatePath("/");
  redirect(`${safeBack}${safeBack.includes("?") ? "&" : "?"}msg=confirmed-${ok}-${failed}`);
}
