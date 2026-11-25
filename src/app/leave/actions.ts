"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { errorText } from "@/lib/access";
import { isIsoDate } from "@/lib/dates";

export type LeaveState = { ok?: string; error?: string } | undefined;

const missing = (code?: string) => code === "PGRST202" || code === "42P01";
const NEEDS_SQL = "The owner needs to run update-0035 in Supabase first.";

export async function fileLeave(_prev: LeaveState, fd: FormData): Promise<LeaveState> {
  const kind = String(fd.get("kind") ?? "");
  const start = String(fd.get("start") ?? "");
  const end = String(fd.get("end") || start);
  const reason = String(fd.get("reason") ?? "").trim();
  if (kind !== "VL" && kind !== "SL") return { error: "Choose vacation leave or sick leave." };
  if (!isIsoDate(start) || !isIsoDate(end) || end < start) return { error: "Check the dates: the last day can't be before the first." };
  if (reason.length < 3) return { error: "Write a short reason." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("request_leave", { p_kind: kind, p_start: start, p_end: end, p_reason: reason });
  if (error) return { error: missing(error.code) ? NEEDS_SQL : "Could not send. Try again." };
  if (!data?.ok) return { error: errorText(data?.error) };
  revalidatePath("/leave"); revalidatePath("/me");
  const n = data.days as number;
  return { ok: `Sent. That's ${n} working day${n === 1 ? "" : "s"}. An owner or the General Manager will decide, and you'll get a notice.` };
}

export async function cancelLeave(_prev: LeaveState, fd: FormData): Promise<LeaveState> {
  const id = z.uuid().safeParse(fd.get("id"));
  if (!id.success) return { error: "Refresh the page and try again." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("cancel_leave", { p_id: id.data });
  if (error || !data?.ok) return { error: error ? "Could not cancel. Try again." : errorText(data?.error) };
  revalidatePath("/leave"); revalidatePath("/me");
  return { ok: "Withdrawn." };
}

export async function decideLeave(_prev: LeaveState, fd: FormData): Promise<LeaveState> {
  const id = z.uuid().safeParse(fd.get("id"));
  const decision = fd.get("decision");
  const note = String(fd.get("note") ?? "").trim();
  if (!id.success) return { error: "Refresh the page and try again." };
  const approve = decision === "paid" || decision === "unpaid";
  if (!approve && note.length < 3) return { error: "Write why, so they know." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("decide_leave", { p_id: id.data, p_approve: approve, p_with_pay: approve ? decision === "paid" : null, p_note: note || null });
  if (error || !data?.ok) return { error: error ? "Could not save. Try again." : errorText(data?.error) };
  revalidatePath("/leave"); revalidatePath("/me"); revalidatePath("/schedule");
  return { ok: approve ? `Approved ${decision === "paid" ? "with pay" : "without pay"}. The schedule is updated and they were told.` : "Declined with your note." };
}
