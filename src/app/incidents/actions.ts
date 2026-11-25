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


export async function acknowledgeIr(_p: ActionState, fd: FormData): Promise<ActionState> {
  const id = z.uuid().safeParse(fd.get("id"));
  if (!id.success) return { error: "Try again." };
  if (fd.get("ack") !== "yes") return { error: "Tick the box to acknowledge that you received this IR." };
  const t = text(fd, "response").slice(0, 2000);
  if (t.length < 3) return { error: "Write your response first." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("acknowledge_ir", { p_id: id.data, p_text: t });
  if (error) return { error: error.code === "PGRST202" ? "The owner needs to run update-0030 in Supabase first." : "Could not send. Try again." };
  if (!data?.ok) return { error: errorText(data?.error) };
  revalidatePath("/incidents"); revalidatePath(`/incidents/${id.data}`); revalidatePath("/me");
  return { ok: "Acknowledged. Your manager will review your response.", at: Date.now() };
}

/** The browser saved the IR's PDF to storage; record it. */
export async function markIrPdf(id: string): Promise<boolean> {
  if (!z.uuid().safeParse(id).success) return false;
  const supabase = await createClient();
  const { data } = await supabase.rpc("mark_ir_pdf", { p_id: id });
  return !!data?.ok;
}

export async function closeIr(_p: ActionState, fd: FormData): Promise<ActionState> {
  const id = z.uuid().safeParse(fd.get("id"));
  if (!id.success) return { error: "Try again." };
  const a = text(fd, "action").slice(0, 1000);
  if (a.length < 3) return { error: "Write the action taken." };
  return call("close_ir", { p_id: id.data, p_action: a }, "Closed.", id.data);
}

