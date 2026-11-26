"use server";
import { revalidatePath } from "next/cache";
import { manilaToday } from "@/lib/dates";
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
  proofs: z.string().max(5000).optional(),
  share: z.literal("1").optional(),
  session: z.coerce.number().int().min(1).max(15).default(1),
  meds: z.union([z.uuid(), z.string().regex(/^free:[0-9a-f-]{36}$/), z.literal("")]).optional(),
});
const Photos = z.array(z.object({ kind: z.enum(["WAIVER", "BEFORE", "AFTER"]), path: z.string().max(300), thumb: z.string().max(300).nullable() })).max(20);

export async function logService(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const p = Log.safeParse(Object.fromEntries(["branch", "date", "service", "amount", "kind", "type", "employee", "partner", "note", "client", "price_note", "folder", "photos", "share", "session", "meds", "proofs"].map((k) => [k, fd.get(k) ?? undefined])));
  if (!p.success) return { error: "Fill in the client's name, the service, the amount paid and who did it." };
  let photos;
  try { photos = Photos.parse(JSON.parse(p.data.photos || "[]")); } catch { return { error: "The photos didn't attach. Remove them and add them again." }; }
  if (p.data.partner && p.data.partner === p.data.employee) return { error: "The lead and the assistant must be different people." };
  const paid = p.data.kind === "PAID";
  const supabase = await createClient();
  // "*": session_prices only exists after update-0068.
  const { data: svcRow } = await supabase.from("services").select("*").eq("id", p.data.service).maybeSingle();
  const sessions = Array.isArray(svcRow?.session_prices) ? (svcRow.session_prices as (number | string)[]).map(Number) : null;
  const zeroOk = !!svcRow && !Number(svcRow.price_cents ?? 0) && svcRow.commission_cents != null; // bundle sessions, later doses
  let cents = 0;
  if (paid) {
    try {
      cents = phpToCents((p.data.amount ?? "").replace(/[,₱\s]/g, ""));
    } catch {
      return { error: "Enter the amount paid, e.g. 2500 or 2500.50" };
    }
    if (cents < 0 || (cents === 0 && !zeroOk)) return { error: "Enter the amount paid. If the client didn't pay, choose Backjob, Check-up or No charge." };
    // A bundle session paid differently from its schedule needs a reason, like a different list price.
    const due = sessions?.[p.data.session - 1];
    if (sessions && due === undefined) return { error: `This bundle has ${sessions.length} sessions. Pick a session from 1 to ${sessions.length}.` };
    if (due !== undefined && cents !== due && (p.data.price_note ?? "").length < 3) return { error: "Write why this session's amount is different from the bundle's schedule." };
  }
  // CHRIS Nov 26: "already logged?" checks the same client and service today (not staff and amount).
  if (fd.get("confirm") !== "1") {
    const like = p.data.client.trim().replace(/[\\%_]/g, (c) => "\\" + c);
    const { data: same } = await supabase.from("service_logs").select("created_at").eq("branch_id", p.data.branch).eq("service_date", p.data.date)
      .eq("service_id", p.data.service).neq("state", "REJECTED").ilike("client_name", like).order("created_at", { ascending: false }).limit(1);
    if (same?.length) {
      const at = new Date(same[0].created_at).toLocaleTimeString("en-PH", { timeZone: "Asia/Manila", hour: "numeric", minute: "2-digit" });
      return { duplicate: `${p.data.client.trim()} already has this service logged today (at ${at}). Is this a separate visit?`, at: Date.now() };
    }
  }
  const { data, error } = await supabase.rpc("log_client_visit", {
    p_branch: p.data.branch, p_date: p.data.date, p_service: p.data.service, p_amount_cents: cents, p_type: !paid ? "NONCOMMI" : p.data.type === "LEAD" && !p.data.partner ? "SOLO" : p.data.type,
    p_employee: p.data.employee, p_partner: paid ? p.data.partner || null : null, p_note: p.data.note || null,
    p_kind: p.data.kind, p_confirm: true, // the client + service check above replaces the old staff + amount check
    p_client: p.data.client, p_price_note: p.data.price_note || null, p_folder: p.data.folder, p_photos: photos, p_share: p.data.share === "1",
    // CHRIS Nov 26: session number (update-0064). Session 1 is the default, so it is sent only when it's 2 to 15.
    ...(p.data.session > 1 ? { p_session: p.data.session } : {}),
  });
  if (error) return { error: error.code === "PGRST202" ? (p.data.session > 1 ? "Session numbers need database update-0064. Ask the owner to run it, or save it as Session 1 for now." : "The owner needs to run update-0053 in Supabase first.") : "Could not save. Try again." };
  if (!data.ok && data.error === "POSSIBLE_DUPLICATE") {
    const at = new Date(data.existing.at).toLocaleTimeString("en-PH", { timeZone: "Asia/Manila", hour: "numeric", minute: "2-digit" });
    return { duplicate: `${data.existing.by} already logged this service for the same staff and amount today at ${at}. Is this a different client?`, at: Date.now() };
  }
  if (!data.ok) return { error: errorText(data.error) };
  // CHRIS Nov 26 (update-0069): meds go in as their own line of this visit, no commission.
  let medsNote = "";
  if (p.data.meds) {
    const free = p.data.meds.startsWith("free:");
    const { data: m, error: mErr } = await supabase.rpc("log_meds", { p_log: data.id, p_service: free ? p.data.meds.slice(5) : p.data.meds, p_free: free });
    medsNote = mErr || !m?.ok ? " The meds didn't save: add them again as their own entry." : free ? " Free meds package added." : " Meds added.";
  }
  // CHRIS Nov 26 (update-0075): optional proof of payment, kept in its own folder.
  let proofs: { path: string; thumb: string | null }[] = [];
  try { proofs = z.array(z.object({ path: z.string().max(300), thumb: z.string().max(300).nullable() })).max(5).parse(JSON.parse(p.data.proofs || "[]")); } catch { proofs = []; }
  if (proofs.length) {
    const { data: pr, error: prErr } = await supabase.rpc("add_payment_proof", { p_log: data.id, p_photos: proofs });
    medsNote += prErr || !pr?.ok ? " The proof of payment didn't save: attach it again on the entry." : " Proof of payment attached.";
  }
  revalidatePath("/services");
  revalidatePath("/me");
  const [{ data: svc }, { data: emp }] = await Promise.all([
    supabase.from("services").select("name").eq("id", p.data.service).maybeSingle(),
    supabase.from("employees").select("commission_eligible").eq("id", p.data.employee).maybeSingle(),
  ]);
  if (isTestService(svc?.name)) {
    return { ok: testResult({ kind: p.data.kind, cents, type: !paid ? "NONCOMMI" : p.data.type === "LEAD" && !p.data.partner ? "SOLO" : p.data.type, eligible: emp?.commission_eligible ?? null, photos, photosDue: !!data.photos_due }), at: Date.now() };
  }
  if (data.photos_due) return { ok: ("Saved. The lead and assist were asked to add the client photos and waiver; their commission is held until they do.") + medsNote, at: Date.now() };
  const on = p.data.date === manilaToday() ? "" : ` for ${new Date(`${p.data.date}T00:00:00Z`).toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}`;
  if (data.state === "APPROVED") return { ok: (paid ? `Saved and approved${on}.` : `Saved${on}. Unpaid visit logged (no commission).`) + medsNote, at: Date.now() };
  return { ok: (paid ? "Saved. Waiting for manager sign-off." : "Saved. Unpaid visit logged (no commission).") + medsNote, at: Date.now() };
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

/** Approve several entries at once (update-0060): the ticked ones, or all waiting ones of the day. */
export async function approveMany(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const raw = fd.get("decision") === "all" ? fd.getAll("all") : fd.getAll("pick");
  const ids = z.array(z.uuid()).max(300).safeParse(raw.map(String));
  if (!ids.success) return { error: "Try again." };
  if (!ids.data.length) return { error: "Tick at least one entry first." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("approve_service_logs", { p_logs: ids.data });
  if (error) return { error: error.code === "PGRST202" ? "The owner needs to run update-0060 in Supabase first." : "Could not save. Try again." };
  if (!data.ok) return { error: errorText(data.error) };
  revalidatePath("/services");
  revalidatePath("/people");
  return { ok: `Approved ${data.approved}.${data.skipped ? ` ${data.skipped} couldn't be (already decided or not yours to approve).` : ""}` };
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

/** CHRIS Nov 26 (update-0073): management moves an entry to the right date. */
export async function changeDate(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const id = z.uuid().safeParse(fd.get("id"));
  const date = z.iso.date().safeParse(fd.get("date"));
  if (!id.success || !date.success) return { error: "Pick the correct date." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("change_service_date", { p_log: id.data, p_date: date.data });
  if (error) return { error: error.code === "PGRST202" ? "Changing dates needs database update-0073. Run it from your To-Do first." : "Could not save. Try again." };
  if (!data.ok) return { error: data.error === "ALREADY_PAID" ? "This entry's commission is already on a final payslip, so its date can't change." : data.error === "INVALID_DATE" ? "Pick today or an earlier day." : errorText(data.error) };
  revalidatePath("/services");
  revalidatePath("/me");
  return { ok: `Moved to ${new Date(`${date.data}T00:00:00Z`).toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}.`, at: Date.now() };
}
