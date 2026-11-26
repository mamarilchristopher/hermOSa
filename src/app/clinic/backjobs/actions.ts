"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { errorText } from "@/lib/access";

export type TagState = { ok?: string; error?: string } | undefined;
const Tag = z.object({ log: z.uuid(), staff: z.union([z.uuid(), z.literal("")]), reason: z.union([z.string().regex(/^[A-Z_]{2,20}$/), z.literal("")]) });

/** Change a backjob's tag (update-0088): who did the first treatment and what needed fixing. Owners and the GM. */
export async function retagBackjob(_prev: TagState, fd: FormData): Promise<TagState> {
  const p = Tag.safeParse({ log: fd.get("log"), staff: fd.get("staff") ?? "", reason: fd.get("reason") ?? "" });
  if (!p.success) return { error: "Pick who did the first treatment and what needed fixing." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("tag_backjob", { p_log: p.data.log, p_staff: p.data.staff || null, p_reason: p.data.reason || null, p_note: null, p_original: null });
  if (error) return { error: error.code === "PGRST202" ? "Backjob tracking needs database update-0088. Ask the owner to run it." : "Could not save. Try again." };
  if (!data?.ok) return { error: errorText(data?.error) };
  revalidatePath("/clinic/backjobs");
  return { ok: "Saved." };
}
