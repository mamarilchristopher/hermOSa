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
