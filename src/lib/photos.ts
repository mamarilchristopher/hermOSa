import type { SupabaseClient } from "@supabase/supabase-js";

/** Signed links (1 hour) for profile pictures in the private profile-photos folder (update-0034). */
export async function photoUrls(supabase: SupabaseClient, paths: (string | null | undefined)[]): Promise<Map<string, string>> {
  const list = [...new Set(paths.filter((p): p is string => !!p))];
  if (!list.length) return new Map();
  const { data } = await supabase.storage.from("profile-photos").createSignedUrls(list, 3600);
  return new Map((data ?? []).filter((d) => d.signedUrl && d.path).map((d) => [d.path as string, d.signedUrl as string]));
}
