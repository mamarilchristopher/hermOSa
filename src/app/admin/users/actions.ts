"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { errorText } from "@/lib/access";

export type FormState = { error?: string; ok?: string } | undefined;
const ROLES = ["OWNER", "FINANCE", "MANAGER", "CASHIER", "HR", "MARKETING", "CLINICIAN", "INVENTORY", "AUDITOR"] as const;

const Grant = z.object({ user: z.uuid(), role: z.enum(ROLES), branch: z.union([z.uuid(), z.literal("ALL")]) });

export async function grantRole(_prev: FormState, fd: FormData): Promise<FormState> {
  const p = Grant.safeParse({ user: fd.get("user"), role: fd.get("role"), branch: fd.get("branch") });
  if (!p.success) return { error: "Pick a person, a role and a branch." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("grant_role", {
    p_user: p.data.user, p_role: p.data.role, p_branch: p.data.branch === "ALL" ? null : p.data.branch,
  });
  if (error) return { error: "Could not save. Try again." };
  if (!data.ok) return { error: data.error === "SELF_ESCALATION_DENIED" ? "You can't change your own roles." : errorText(data.error) };
  revalidatePath("/admin/users");
  return { ok: data.duplicate ? "They already have that role." : "Role added." };
}

export async function revokeRole(fd: FormData) {
  const p = z.uuid().safeParse(fd.get("grant"));
  if (!p.success) return;
  const supabase = await createClient();
  await supabase.rpc("revoke_role", { p_grant: p.data });
  revalidatePath("/admin/users");
}

export async function setActive(fd: FormData) {
  const p = z.object({ user: z.uuid(), name: z.string().min(1).max(120), active: z.enum(["true", "false"]) })
    .safeParse({ user: fd.get("user"), name: fd.get("name"), active: fd.get("active") });
  if (!p.success) return;
  const supabase = await createClient();
  await supabase.rpc("update_staff_user", { p_user: p.data.user, p_display_name: p.data.name, p_active: p.data.active === "true" });
  revalidatePath("/admin/users");
}
