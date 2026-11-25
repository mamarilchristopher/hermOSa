"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { errorText } from "@/lib/access";

export type PhotoState = { ok?: string; error?: string } | undefined;

/** After the browser uploaded the photo into the person's own folder: send it for approval. */
export async function submitProfilePhoto(path: string): Promise<PhotoState> {
  if (!/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.jpg$/.test(path)) return { error: "Refresh the page and try again." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("submit_profile_photo", { p_path: path });
  if (error) return { error: error.code === "PGRST202" ? "The owner needs to run update-0034 in Supabase first." : "Could not send. Try again." };
  if (!data?.ok) return { error: errorText(data?.error) };
  revalidatePath("/me/photo"); revalidatePath("/me");
  return { ok: "Sent. An owner will approve it, then it shows on your account." };
}
