"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

/** Remove a version added by mistake (owners and the GM, update-0082). */
export async function removeDocumentVersion(id: string): Promise<{ error?: string }> {
  if (!z.uuid().safeParse(id).success) return { error: "Not found." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("remove_document_version", { p_id: id });
  if (error) return { error: error.code === "PGRST202" ? "The owner needs to run update-0082 in Supabase first." : "Could not remove. Try again." };
  const r = data as { ok: boolean; error?: string };
  if (!r.ok) return { error: r.error === "FORBIDDEN" ? "Only owners and the GM can remove documents." : "Could not remove. Try again." };
  revalidatePath("/documents");
  return {};
}
