"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { errorText } from "@/lib/access";

export type FormState = { error?: string; ok?: string; values?: Record<string, string>; n?: number } | undefined;
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

const LEVELS = ["OWNER", "GM", "SENIOR_CMA", "CMA", "MANAGER", "CASHIER", "FINANCE", "HR"] as const;
const Approve = z.object({
  user: z.uuid(),
  level: z.enum(LEVELS),
  branch: z.uuid(),
  position: z.string().trim().max(80).optional(),
  commission: z.enum(["default", "yes", "no"]),
});

export async function approveJoin(prev: FormState, fd: FormData): Promise<FormState> {
  // Keep what was picked so a failed attempt doesn't clear the form.
  const values = Object.fromEntries(["level", "branch", "position", "commission"].map((k) => [k, String(fd.get(k) ?? "")]));
  const n = (prev?.n ?? 0) + 1;
  const fail = (error: string): FormState => ({ error, values, n });
  if (!fd.get("level")) return fail(errorText("LEVEL_REQUIRED"));
  const p = Approve.safeParse({
    user: fd.get("user"), level: fd.get("level"), branch: fd.get("branch"),
    position: (fd.get("position") as string) || undefined, commission: fd.get("commission") ?? "default",
  });
  if (!p.success) return fail("Choose a staff level and a home branch.");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("approve_join_request", {
    p_user: p.data.user, p_level: p.data.level, p_branch: p.data.branch, p_position: p.data.position ?? null,
    p_commission: p.data.commission === "default" ? null : p.data.commission === "yes",
  });
  // Owner-only screen: show the database's own reason so a setup problem can be fixed quickly.
  if (error) {
    console.error("approve_join_request failed", error.code, error.message);
    return fail(`Could not save. Database says: ${error.message}${error.code ? ` (${error.code})` : ""}`);
  }
  if (!data.ok) return fail(errorText(data.error));
  revalidatePath("/admin/users");
  return { ok: "Approved. They can use the app now." };
}

export async function rejectJoin(fd: FormData) {
  const p = z.uuid().safeParse(fd.get("user"));
  if (!p.success) return;
  const supabase = await createClient();
  await supabase.rpc("reject_join_request", { p_user: p.data });
  revalidatePath("/admin/users");
}

export async function createInvite(_prev: FormState, fd: FormData): Promise<FormState> {
  const days = z.coerce.number().int().min(1).max(90).safeParse(fd.get("days") ?? 14);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_staff_invite", { p_days: days.success ? days.data : 14 });
  if (error) return { error: "Could not make a link. Try again." };
  if (!data.ok) return { error: errorText(data.error) };
  revalidatePath("/admin/users");
  return { ok: "New invite link made." };
}

export async function revokeInvite(fd: FormData) {
  const p = z.uuid().safeParse(fd.get("invite"));
  if (!p.success) return;
  const supabase = await createClient();
  await supabase.rpc("revoke_staff_invite", { p_invite: p.data });
  revalidatePath("/admin/users");
}
