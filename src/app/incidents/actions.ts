"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { errorText } from "@/lib/access";

export type ActionState = { error?: string; ok?: string; at?: number } | undefined;

async function call(fn: string, args: Record<string, unknown>, okText: string, id?: string): Promise<ActionState> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc(fn, args);
  if (error) return { error: error.code === "PGRST202" ? "The owner needs to run update-0023 in Supabase first." : "Could not save. Try again." };
  if (!data?.ok) return { error: errorText(data?.error) };
  revalidatePath("/incidents"); if (id) revalidatePath(`/incidents/${id}`); revalidatePath("/me");
  return { ok: okText, at: Date.now() };
}
const text = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

export async function issueIr(_p: ActionState, fd: FormData): Promise<ActionState> {
  const id = z.uuid().safeParse(fd.get("id"));
  if (!id.success) return { error: "Try again." };
  const issue = fd.get("decision") === "issue";
  const note = text(fd, "note").slice(0, 1000);
  if (!issue && note.length < 3) return { error: "Say why you're dismissing it." };
  return call("issue_ir", { p_id: id.data, p_issue: issue, p_note: note || null }, issue ? "Issued. They were notified to explain." : "Dismissed.", id.data);
}

export async function explainIr(_p: ActionState, fd: FormData): Promise<ActionState> {
  const id = z.uuid().safeParse(fd.get("id"));
  if (!id.success) return { error: "Try again." };
  const t = text(fd, "explanation").slice(0, 2000);
  if (t.length < 3) return { error: "Write your explanation first." };
  return call("explain_ir", { p_id: id.data, p_text: t }, "Sent. Your manager will review it.", id.data);
}

export async function closeIr(_p: ActionState, fd: FormData): Promise<ActionState> {
  const id = z.uuid().safeParse(fd.get("id"));
  if (!id.success) return { error: "Try again." };
  const a = text(fd, "action").slice(0, 1000);
  if (a.length < 3) return { error: "Write the action taken." };
  return call("close_ir", { p_id: id.data, p_action: a }, "Closed.", id.data);
}

export async function setLimit(_p: ActionState, fd: FormData): Promise<ActionState> {
  const m = z.coerce.number().int().min(1).max(1440).safeParse(fd.get("minutes"));
  if (!m.success) return { error: "Enter minutes from 1 to 1440." };
  return call("set_ir_late_limit", { p_minutes: m.data }, `Saved. An IR is drafted at ${m.data} late minutes per cutoff.`);
}
