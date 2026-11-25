"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { errorText } from "@/lib/access";

export async function setSharing(_prev: { on?: boolean; error?: string } | undefined, fd: FormData) {
  const id = z.uuid().safeParse(fd.get("log"));
  if (!id.success) return { error: "Try again." };
  const share = fd.get("share") === "1";
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("set_photo_sharing", { p_log: id.data, p_share: share });
  if (error) return { error: "Could not save. Try again." };
  if (!data.ok) return { error: errorText(data.error) };
  revalidatePath("/clinic/social");
  revalidatePath("/clinic/archive");
  return { on: share };
}

/** Owners and the GM (update-0057): delete one client folder, its service log entry, commission lines and photo files. */
export async function deleteClientVisit(_prev: { done?: boolean; error?: string } | undefined, fd: FormData) {
  const id = z.uuid().safeParse(fd.get("log"));
  if (!id.success) return { error: "Try again." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("delete_client_visit", { p_log: id.data });
  if (error) return { error: error.code === "PGRST202" ? "The owner needs to run update-0057 in Supabase first." : "Could not delete. Try again." };
  if (!data.ok) return { error: data.error === "ALREADY_PAID" ? "Its commission is already on a final payslip, so it can't be deleted." : errorText(data.error) };
  const paths = (Array.isArray(data.paths) ? data.paths : []) as string[];
  for (let i = 0; i < paths.length; i += 100) await supabase.storage.from("client-photos").remove(paths.slice(i, i + 100));
  revalidatePath("/clinic/social");
  revalidatePath("/clinic/archive");
  revalidatePath("/services");
  return { done: true };
}
