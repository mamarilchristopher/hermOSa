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

export type CaseState = { ok?: string; error?: string; n?: number } | undefined;
const Case = z.object({
  id: z.uuid(),
  status: z.enum(["OPEN", "IN_PROGRESS", "RESOLVED", "REFUNDED", "QUITCLAIM", "NO_RESPONSE"]),
  resolution: z.string().trim().max(500),
  refund: z.string().trim().regex(/^$|^\d{1,7}(\.\d{1,2})?$/),
});

/** Move a backjob case along or close it (update-0090): fixed, refunded, quitclaim signed, or client stopped responding. */
export async function updateCase(prev: CaseState, fd: FormData): Promise<CaseState> {
  const n = (prev?.n ?? 0) + 1;
  const p = Case.safeParse({ id: fd.get("id"), status: fd.get("status"), resolution: fd.get("resolution") ?? "", refund: String(fd.get("refund") ?? "").replace(/[₱,\s]/g, "") });
  if (!p.success) return { error: "Check the status, the note (up to 500 letters) and the refund amount.", n };
  const closing = !["OPEN", "IN_PROGRESS"].includes(p.data.status);
  if (closing && p.data.resolution.length < 3) return { error: "Write what was done before closing the case.", n };
  const cents = p.data.refund ? Math.round(Number(p.data.refund) * 100) : null;
  if (p.data.status === "REFUNDED" && !cents) return { error: "Type the refund amount.", n };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("update_backjob_case", { p_case: p.data.id, p_status: p.data.status, p_resolution: p.data.resolution || null, p_refund_cents: cents });
  if (error) return { error: error.code === "PGRST202" ? "Backjob cases need database update-0090. Ask the owner to run it." : "Could not save. Try again.", n };
  if (!data?.ok) return { error: data?.error === "RESOLUTION_REQUIRED" ? "Write what was done before closing the case." : errorText(data?.error), n };
  revalidatePath("/clinic/backjobs");
  revalidatePath("/focus");
  return { ok: closing ? "Case closed." : "Saved.", n };
}
