"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { errorText } from "@/lib/access";

export type EmpState = { error?: string; ok?: string } | undefined;

const Emp = z.object({
  id: z.union([z.uuid(), z.literal("")]).optional(),
  branch: z.uuid(),
  name: z.string().trim().min(2).max(120),
  position: z.string().trim().max(80).optional(),
  commission: z.enum(["yes", "no"]),
  login: z.union([z.uuid(), z.literal("")]).optional(),
  active: z.enum(["yes", "no"]).optional(),
});

export async function saveEmployee(_prev: EmpState, fd: FormData): Promise<EmpState> {
  const p = Emp.safeParse(Object.fromEntries(["id", "branch", "name", "position", "commission", "login", "active"].map((k) => [k, fd.get(k) ?? undefined])));
  if (!p.success) return { error: "Enter the name and branch." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("save_employee", {
    p_id: p.data.id || null, p_branch: p.data.branch, p_name: p.data.name, p_position: p.data.position || null,
    p_commission: p.data.commission === "yes", p_app_user: p.data.login || null, p_active: p.data.active ? p.data.active === "yes" : true,
  });
  if (error) return { error: "Could not save. Try again." };
  if (!data.ok) return { error: errorText(data.error) };
  revalidatePath("/people");
  return { ok: p.data.id ? "Saved." : `Added ${p.data.name}.` };
}

/** Change only the position title. Every other field is kept exactly as it is. */
export async function setPosition(_prev: EmpState, fd: FormData): Promise<EmpState> {
  const p = z.object({ id: z.uuid(), position: z.string().trim().max(80) }).safeParse({ id: fd.get("id"), position: fd.get("position") });
  if (!p.success) return { error: "Positions can be up to 80 characters." };
  const supabase = await createClient();
  const { data: e } = await supabase.from("employees").select("id, branch_id, full_name, commission_eligible, app_user_id, active").eq("id", p.data.id).maybeSingle();
  if (!e) return { error: errorText("NOT_FOUND") };
  const { data, error } = await supabase.rpc("save_employee", {
    p_id: e.id, p_branch: e.branch_id, p_name: e.full_name, p_position: p.data.position || null,
    p_commission: e.commission_eligible, p_app_user: e.app_user_id, p_active: e.active,
  });
  if (error) return { error: "Could not save. Try again." };
  if (!data.ok) return { error: errorText(data.error) };
  revalidatePath("/people");
  revalidatePath("/admin/users");
  return { ok: "Saved" };
}
