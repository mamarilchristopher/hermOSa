"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { phpToCents } from "@/lib/csv";
import { errorText } from "@/lib/access";

export type ActionState = { error?: string; ok?: string; at?: number } | undefined;

const Log = z.object({
  branch: z.uuid(),
  date: z.iso.date(),
  service: z.uuid(),
  amount: z.string().trim().min(1).max(20),
  type: z.enum(["LEAD", "ASSIST", "SOLO", "NONCOMMI"]),
  employee: z.uuid(),
  partner: z.union([z.uuid(), z.literal("")]).optional(),
  receipt: z.string().trim().max(40).optional(),
  note: z.string().trim().max(300).optional(),
});

export async function logService(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const p = Log.safeParse(Object.fromEntries(["branch", "date", "service", "amount", "type", "employee", "partner", "receipt", "note"].map((k) => [k, fd.get(k) ?? undefined])));
  if (!p.success) return { error: "Fill in the service, amount paid and who did it." };
  let cents: number;
  try {
    cents = phpToCents(p.data.amount.replace(/[,₱\s]/g, ""));
  } catch {
    return { error: "Enter the amount paid, e.g. 2500 or 2500.50" };
  }
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("log_service", {
    p_branch: p.data.branch, p_date: p.data.date, p_service: p.data.service, p_amount_cents: cents, p_type: p.data.type,
    p_employee: p.data.employee, p_partner: p.data.partner || null, p_receipt: p.data.receipt || null, p_note: p.data.note || null,
  });
  if (error) return { error: "Could not save. Try again." };
  if (!data.ok) return { error: errorText(data.error) };
  revalidatePath("/services");
  return { ok: "Saved. Waiting for manager sign-off.", at: Date.now() };
}

export async function decideLog(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const id = z.uuid().safeParse(fd.get("log"));
  const approve = fd.get("decision") === "approve";
  if (!id.success) return { error: "Try again." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("decide_service_log", { p_log: id.data, p_approve: approve, p_note: String(fd.get("note") ?? "") || null });
  if (error) return { error: "Could not save. Try again." };
  if (!data.ok) return { error: errorText(data.error) };
  revalidatePath("/services");
  revalidatePath("/people");
  return { ok: approve ? "Approved" : "Rejected" };
}

export async function addService(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const name = z.string().trim().min(2).max(120).safeParse(fd.get("name"));
  if (!name.success) return { error: "Type the service name." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("add_service", { p_name: name.data });
  if (error) return { error: "Could not save. Try again." };
  if (!data.ok) return { error: errorText(data.error) };
  revalidatePath("/services");
  return { ok: data.duplicate ? "That service is already in the list." : `Added "${name.data}".` };
}
