"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { errorText } from "@/lib/access";

export type ActionState = { error?: string; ok?: string; at?: number } | undefined;

const MORE: Record<string, string> = {
  REASON_REQUIRED: "Write a few words first.",
  NOT_PENDING: "This was already answered or changed. Refresh the page.",
  NOTHING_TO_ISSUE: "There are no Late NTEs this month that aren't in an IR yet.",
  PROOF_REQUIRED: "Add a photo as proof first (a photo of the traffic, or a screenshot of your ride booking).",
  PHOTO_NOT_UPLOADED: "A photo didn't finish uploading. Remove it and add it again.",
  PINGED_RECENTLY: "Already reminded in the last 10 minutes. Try again later.",
  NO_APP_ACCOUNT: "This employee has no Hermosapp account yet, so they can't be reminded in the app.",
};
const text = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const msg = (code: string | undefined) => (code && MORE[code]) || errorText(code);
const NEEDS_SQL = "The owner needs to run update-0030 in Supabase first.";

function refresh() { revalidatePath("/nte"); revalidatePath("/me"); revalidatePath("/time"); revalidatePath("/incidents"); }

export async function explainNte(_p: ActionState, fd: FormData): Promise<ActionState> {
  const id = z.uuid().safeParse(fd.get("id"));
  const t = text(fd, "explanation").slice(0, 2000);
  if (!id.success) return { error: "Refresh the page and try again." };
  if (t.length < 3) return { error: "Write why you were late." };
  // CHRIS Nov 26 (update-0065): photo proof is required, 1 to 3 photos already uploaded to nte-proofs/<nte id>/.
  let proof: string[] = [];
  try { proof = z.array(z.string().max(200)).max(3).parse(JSON.parse(String(fd.get("proof") ?? "[]"))); } catch { return { error: "The photos didn't attach. Remove them and add them again." }; }
  if (proof.length === 0) return { error: MORE.PROOF_REQUIRED };
  const { data, error } = await (await createClient()).rpc("explain_nte", { p_id: id.data, p_text: t, p_proof: proof });
  if (error) return { error: error.code === "PGRST202" ? "Photo proof needs database update-0065. Ask the owner to run it." : "Could not send. Try again." };
  if (!data?.ok) return { error: msg(data?.error) };
  refresh();
  return { ok: "Sent. Thank you.", at: Date.now() };
}

/** Management: accept the reason (doesn't count toward an IR) or reject it (counts). update-0067. */
export async function reviewNte(_p: ActionState, fd: FormData): Promise<ActionState> {
  const id = z.uuid().safeParse(fd.get("id"));
  const d = String(fd.get("decision") ?? "");
  if (!id.success || !["accept", "reject"].includes(d)) return { error: "Refresh the page and try again." };
  const { data, error } = await (await createClient()).rpc("review_nte", { p_id: id.data, p_accept: d === "accept", p_note: text(fd, "note").slice(0, 500) || null });
  if (error) return { error: error.code === "PGRST202" ? "Accept / Reject needs database update-0067. Ask the owner to run it." : "Could not save. Try again." };
  if (!data?.ok) return { error: msg(data?.error) };
  refresh();
  return { ok: d === "accept" ? "Reason accepted. It doesn't count toward an IR." : "Reason rejected. It counts toward an IR.", at: Date.now() };
}

export async function voidNte(_p: ActionState, fd: FormData): Promise<ActionState> {
  const id = z.uuid().safeParse(fd.get("id"));
  const r = text(fd, "reason").slice(0, 500);
  if (!id.success) return { error: "Refresh the page and try again." };
  if (r.length < 3) return { error: "Say why it doesn't count." };
  const { data, error } = await (await createClient()).rpc("void_nte", { p_id: id.data, p_reason: r });
  if (error) return { error: error.code === "PGRST202" ? NEEDS_SQL : "Could not save. Try again." };
  if (!data?.ok) return { error: msg(data?.error) };
  refresh();
  return { ok: "Cancelled. It no longer counts.", at: Date.now() };
}

export async function issueLateIr(_p: ActionState, fd: FormData): Promise<ActionState> {
  const emp = z.uuid().safeParse(fd.get("employee"));
  const month = z.string().regex(/^\d{4}-\d{2}-01$/).safeParse(fd.get("month"));
  if (!emp.success || !month.success) return { error: "Refresh the page and try again." };
  const { data, error } = await (await createClient()).rpc("issue_late_ir", { p_employee: emp.data, p_month: month.data, p_note: text(fd, "note").slice(0, 1000) || null });
  if (error) return { error: error.code === "PGRST202" ? NEEDS_SQL : "Could not issue. Try again." };
  if (!data?.ok) return { error: msg(data?.error) };
  refresh();
  redirect(`/incidents/${data.id}?issued=1`);
}

/** Management: remind the employee to explain a Late NTE (notification + phone push). update-0094, CHRIS Nov 27. */
export async function pingNte(_p: ActionState, fd: FormData): Promise<ActionState> {
  const id = z.uuid().safeParse(fd.get("id"));
  if (!id.success) return { error: "Refresh the page and try again." };
  const { data, error } = await (await createClient()).rpc("ping_nte", { p_id: id.data });
  if (error) return { error: error.code === "PGRST202" ? "Ping needs database update-0094. Ask the owner to run it." : "Could not send. Try again." };
  if (!data?.ok) return { error: msg(data?.error) };
  refresh();
  return { ok: `Reminder sent${data.count > 1 ? ` (${data.count} times so far)` : ""}.`, at: Date.now() };
}
