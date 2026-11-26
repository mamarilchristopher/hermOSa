import type { SupabaseClient } from "@supabase/supabase-js";
import type { DutyRow } from "@/components/OnDuty";
import type { DutyFace } from "@/components/OnDutyFaces";
import { photoUrls } from "./photos";
import { shortNames } from "./schedule";

/** Nickname (or first name) and approved profile picture for each person on the On duty list (CHRIS Nov 25). */
export async function loadFaces(supabase: SupabaseClient, duty: DutyRow[]): Promise<Record<string, DutyFace>> {
  const ids = [...new Set(duty.map((r) => r.employee_id))];
  if (!ids.length) return {};
  const { data: emps } = await supabase.from("employees").select("id, full_name, nickname, app_user_id").in("id", ids);
  const list = (emps ?? []) as { id: string; full_name: string; nickname: string | null; app_user_id: string | null }[];
  const userIds = list.map((e) => e.app_user_id).filter((x): x is string => !!x);
  const { data: users } = userIds.length ? await supabase.from("app_users").select("id, photo_path").in("id", userIds) : { data: [] };
  const pathOf = new Map(((users ?? []) as { id: string; photo_path: string | null }[]).map((u) => [u.id, u.photo_path]));
  const urls = await photoUrls(supabase, [...pathOf.values()]);
  const names = shortNames(list.map((e) => ({ id: e.id, name: e.full_name, nick: e.nickname })));
  const out: Record<string, DutyFace> = {};
  for (const e of list) {
    const path = e.app_user_id ? pathOf.get(e.app_user_id) : null;
    out[e.id] = { short: names[e.id] ?? e.full_name, photo: path ? urls.get(path) ?? null : null, user: e.app_user_id };
  }
  return out;
}
