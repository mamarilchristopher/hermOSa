"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { errorText } from "@/lib/access";

export type PunchState = { error?: string; ok?: string; at?: number; far?: number | null } | undefined;

const Punch = z.object({
  kind: z.enum(["IN", "OUT"]), branch: z.uuid(), photo: z.string().regex(/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.jpg$/),
  lat: z.coerce.number().min(-90).max(90).optional(), lng: z.coerce.number().min(-180).max(180).optional(), acc: z.coerce.number().int().min(0).max(100000).optional(),
  taken: z.iso.datetime().optional(),
});

/** Time in / out. The photo is already uploaded; the database stamps the time. */
export async function clockPunch(input: { kind: string; branch: string; photo: string; lat?: number; lng?: number; acc?: number; taken?: string }): Promise<PunchState> {
  const p = Punch.safeParse(input);
  if (!p.success) return { error: "Take your photo, then try again." };
  try {
    return await punch(p.data);
  } catch (e) {
    console.error("clock_punch failed", e);
    return { error: `Could not save. Try again. (${e instanceof Error ? e.message.slice(0, 120) : "server error"})` };
  }
}

async function punch(d: z.infer<typeof Punch>): Promise<PunchState> {
  const p = { data: d };
  const supabase = await createClient();
  const args = { p_kind: p.data.kind, p_branch: p.data.branch, p_photo: p.data.photo,
    p_lat: p.data.lat ?? null, p_lng: p.data.lng ?? null, p_accuracy: p.data.acc ?? null };
  let { data, error } = await supabase.rpc("clock_punch", { ...args, p_photo_taken_at: p.data.taken ?? null });
  // Before update-0026 the function has no photo-time argument: save without it.
  if (error?.code === "PGRST202") ({ data, error } = await supabase.rpc("clock_punch", args));
  if (error) { console.error("clock_punch rpc", error); return { error: error.code === "PGRST202" ? "The owner needs to run update-0022 in Supabase first." : `Could not save. Try again. (${error.message.slice(0, 120)})` }; }
  if (!data?.ok) return { error: errorText(data?.error) };
  try { revalidatePath("/time"); revalidatePath("/me"); } catch (e) { console.error("revalidate", e); }
  const at = new Date(data.at).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Manila" });
  return { ok: `${p.data.kind === "IN" ? "Timed in" : "Timed out"} at ${at}.`, at: Date.now(), far: data.distance_m ?? null };
}

const Loc = z.object({ branch: z.uuid(), lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });
export async function setBranchLocation(input: { branch: string; lat: number; lng: number }): Promise<PunchState> {
  const p = Loc.safeParse(input);
  if (!p.success) return { error: "Could not read this phone's location." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("set_branch_location", { p_branch: p.data.branch, p_lat: p.data.lat, p_lng: p.data.lng });
  if (error) return { error: "Could not save. Try again." };
  if (!data?.ok) return { error: errorText(data?.error) };
  revalidatePath("/time");
  return { ok: "Branch location saved.", at: Date.now() };
}
