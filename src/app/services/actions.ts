"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { phpToCents } from "@/lib/csv";
import { errorText } from "@/lib/access";
import { isTestService } from "@/lib/serviceOrder";
import { testResult } from "@/lib/serviceTest";

export type ActionState = { error?: string; ok?: string; at?: number; duplicate?: string } | undefined;

const Log = z.object({
  branch: z.uuid(),
  date: z.iso.date(),
  service: z.uuid(),
  amount: z.string().trim().max(20).optional(),
  kind: z.enum(["PAID", "BACKJOB", "CHECKUP", "NO_CHARGE"]),
  type: z.enum(["LEAD", "ASSIST", "SOLO", "NONCOMMI"]),
  employee: z.uuid(),
  partner: z.union([z.uuid(), z.literal("")]).optional(),
  note: z.string().trim().max(300).optional(),
  client: z.string().trim().min(2).max(120),
  price_note: z.string().trim().max(300).optional(),
  folder: z.uuid(),
  photos: z.string().max(20000),
  share: z.literal("1").optional(),
});
const Photos = z.array(z.object({ kind: z.enum(["WAIVER", "BEFORE", "AFTER"]), path: z.string().max(300), thumb: z.string().max(300).nullable() })).max(20);

export async function logService(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const p = Log.safeParse(Object.fromEntries(["branch", "date", "service", "amount", "kind", "type", "employee", "partner", "note", "client", "price_note", "folder", "photos", "share"].map((k) => [k, fd.get(k) ?? undefined])));
  if (!p.success) return { error: "Fill in the client's name, the service, the amount paid and who did it." };
  let photos;
  try { photos = Photos.parse(JSON.parse(p.data.photos || "[]")); } catch { return { error: "The photos didn't attach. Remove them and add them again." }; }
  const paid = p.data.kind === "PAID";
  let cents = 0;
  if (paid) {
    try {
      cents = phpToCents((p.data.amount ?? "").replace(/[,₱\s]/g, ""));
    } catch {
      return { error: "Enter the amount paid, e.g. 2500 or 2500.50" };
    }
    if (cents <= 0) return { error: "Enter the amount paid. If the client didn't pay, choose Backjob, Check-up or No charge." };
  }
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("log_client_visit", {
    p_branch: p.data.branch, p_date: p.data.date, p_service: p.data.service, p_amount_cents: cents, p_type: !paid ? "NONCOMMI" : p.data.type === "LEAD" && !p.data.partner ? "SOLO" : p.data.type,
    p_employee: p.data.employee, p_partner: paid ? p.data.partner || null : null, p_note: p.data.note || null,
    p_kind: p.data.kind, p_confirm: fd.get("confirm") === "1",
    p_client: p.data.client, p_price_note: p.data.price_note || null, p_folder: p.data.folder, p_photos: photos, p_share: p.data.share === "1",
  });
  if (error) return { error: error.code === "PGRST202" ? "The owner needs to run update-0053 in Supabase first." : "Could not save. Try again." };
  if (!data.ok && data.error === "POSSIBLE_DUPLICATE") {
    const at = new Date(data.existing.at).toLocaleTimeString("en-PH", { timeZone: "Asia/Manila", hour: "numeric", minute: "2-digit" });
    return { duplicate: `${data.existing.by} already logged this service for the same staff and amount today at ${at}. Is this a different client?`, at: Date.now() };
  }
  if (!data.ok) return { error: errorText(data.error) };
  revalidatePath("/services");
  revalidatePath("/me");
  const [{ data: svc }, { data: emp }] = await Promise.all([
    supabase.from("services").select("name").eq("id", p.data.service).maybeSingle(),
    supabase.from("employees").select("commission_eligible").eq("id", p.data.employee).maybeSingle(),
  ]);
  if (isTestService(svc?.name)) {
    return { ok: testResult({ kind: p.data.kind, cents, type: !paid ? "NONCOMMI" : p.data.type === "LEAD" && !p.data.partner ? "SOLO" : p.data.type, eligible: emp?.commission_eligible ?? null, photos, photosDue: !!data.photos_due }), at: Date.now() };
  }
  if (data.photos_due) return { ok: "Saved. The lead and assist were asked to add the client photos and waiver; their commission is held until they do.", at: Date.now() };
  return { ok: paid ? "Saved. Waiting for manager sign-off." : "Saved. Unpaid visit logged (no commission).", at: Date.now() };
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
