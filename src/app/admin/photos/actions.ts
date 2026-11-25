"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { errorText } from "@/lib/access";

export type DecideState = { ok?: string; error?: string } | undefined;

export async function decidePhoto(_prev: DecideState, fd: FormData): Promise<DecideState> {
  const id = z.uuid().safeParse(fd.get("id"));
  const approve = fd.get("decision") === "approve";
  const note = String(fd.get("note") ?? "").trim();
  if (!id.success) return { error: "Refresh the page and try again." };
  if (!approve && note.length < 3) return { error: "Write why, so they know what photo to send instead." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("decide_profile_photo", { p_id: id.data, p_approve: approve, p_note: approve ? null : note });
  if (error || !data?.ok) return { error: error ? "Could not save. Try again." : errorText(data?.error) };
  revalidatePath("/admin/photos"); revalidatePath("/me");
  return { ok: approve ? "Approved. It now shows on their account." : "Sent back with your note." };
}
