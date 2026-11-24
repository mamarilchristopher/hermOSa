"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

/** Mark all of your notices read. */
export async function markNoticesRead(): Promise<void> {
  const supabase = await createClient();
  await supabase.rpc("mark_notifications_read", { p_ids: null });
  revalidatePath("/", "layout");
}
