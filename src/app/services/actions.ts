"use server";
import { revalidatePath } from "next/cache";
import { manilaToday } from "@/lib/dates";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { centsToPhp, phpToCents } from "@/lib/csv";
import { errorText } from "@/lib/access";
import { isTestService } from "@/lib/serviceOrder";
import { testResult } from "@/lib/serviceTest";
import { firstPlan, promoOf, type PromoOptions } from "@/lib/promoTrack";

export type ActionState = { error?: string; ok?: string; at?: number; duplicate?: string; link?: string } | undefined;

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
  addons: z.string().max(2000).optional(),
  promo_client: z.union([z.uuid(), z.literal("new"), z.literal("")]).optional(),
  promo_contact: z.string().trim().max(40).optional(),
});
const Photos = z.array(z.object({ kind: z.enum(["WAIVER", "BEFORE", "AFTER"]), path: z.string().max(300), thumb: z.string().max(300).nullable() })).max(20);

export async function logService(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const p = Log.safeParse(Object.fromEntries(["branch", "date", "service", "amount", "kind", "type", "employee", "partner", "note", "client", "price_note", "folder", "photos", "share", "session", "meds", "proofs", "addons", "promo_client", "promo_contact"].map((k) => [k, fd.get(k) ?? undefined])));
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
  // CHRIS Nov 26 (update-0080): add-ons, each its own line of this visit at 5% commission. Checked before anything is saved.
  let addons: { service: string; cents: number }[] = [];
  if (paid && p.data.addons) {
    try {
      addons = z.array(z.object({ service: z.uuid(), amount: z.string().max(20) })).max(5).parse(JSON.parse(p.data.addons))
        .map((a) => ({ service: a.service, cents: phpToCents(a.amount.replace(/[,₱\s]/g, "")) }));
    } catch { return { error: "Enter what the client paid for each add-on, e.g. 500." }; }
    if (addons.some((a) => !(a.cents > 0))) return { error: "Enter what the client paid for each add-on, e.g. 500." };
  }
  // update-0087: a promo item needs the client's promo (or "new" to start it); price 0 / no price = bundles, promo items.
  const mayBePromo = !!svcRow && !Number(svcRow.price_cents ?? 0);
  const { data: promoData } = mayBePromo ? await supabase.rpc("promo_log_options") : { data: null };
  const pm = promoData?.ok ? promoOf(p.data.service, promoData as PromoOptions) : null;
  if (pm && !p.data.promo_client) return { error: `Pick the client's promo for ${pm.promo.title}, or "New client" if they're buying it today.` };
  if (pm && !paid) return { error: "Promo sessions are logged as Paid (₱0 when the client already paid). For a backjob or check-up, pick the usual service." };
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
  const promoArgs = pm ? {
    p_promo_client: p.data.promo_client === "new" ? null : p.data.promo_client,
    p_new: p.data.promo_client === "new" ? { promo_id: pm.promo.id, contact: p.data.promo_contact || null, schedule: firstPlan(pm.promo, p.data.date) } : null,
    p_session: pm.part && !pm.promo.pay_service_id ? p.data.session : null,
  } : null;
  const { data, error } = pm ? await supabase.rpc("log_promo_visit", {
    ...promoArgs,
    p_branch: p.data.branch, p_date: p.data.date, p_service: p.data.service, p_amount_cents: cents, p_type: p.data.type === "LEAD" && !p.data.partner ? "SOLO" : p.data.type,
    p_employee: p.data.employee, p_partner: p.data.partner || null, p_note: p.data.note || null,
    p_client: p.data.client, p_price_note: p.data.price_note || null, p_folder: p.data.folder, p_photos: photos, p_share: p.data.share === "1",
  }) : await supabase.rpc("log_client_visit", {
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
  if (!data.ok && pm) return { error: promoError(data) };
  if (!data.ok) return { error: errorText(data.error) };
  // CHRIS Nov 26 (update-0069): meds go in as their own line of this visit, no commission.
  let medsNote = "";
  if (p.data.meds) {
    const free = p.data.meds.startsWith("free:");
    const { data: m, error: mErr } = await supabase.rpc("log_meds", { p_log: data.id, p_service: free ? p.data.meds.slice(5) : p.data.meds, p_free: free });
    medsNote = mErr || !m?.ok ? " The meds didn't save: add them again as their own entry." : free ? " Free meds package added." : " Meds added.";
  }
  let addonsOk = 0;
  for (const a of addons) {
    const { data: ad, error: adErr } = await supabase.rpc("log_addon", { p_log: data.id, p_service: a.service, p_amount_cents: a.cents });
    if (!adErr && ad?.ok) { addonsOk++; continue; }
    medsNote += adErr?.code === "PGRST202" ? " Add-ons need database update-0080: ask the owner to run it, then log the add-on as its own entry."
      : ` An add-on didn't save${ad?.error ? ` (${errorText(ad.error)})` : ""}: log it again as its own entry.`;
  }
  if (addonsOk) medsNote += addonsOk === 1 ? " Add-on added." : ` ${addonsOk} add-ons added.`;
  // update-0088 (CHRIS Nov 27): tag the backjob (what needed fixing, first treatment and who did it) for tracking.
  if (p.data.kind === "BACKJOB") {
    const staff = String(fd.get("bj_staff") ?? "");
    const reason = String(fd.get("bj_reason") ?? "");
    const { data: bj, error: bjErr } = await supabase.rpc("tag_backjob", {
      p_log: data.id, p_staff: /^[0-9a-f-]{36}$/.test(staff) ? staff : null, p_reason: /^[A-Z_]{2,20}$/.test(reason) ? reason : null, p_note: null, p_original: null,
    });
    if (bjErr?.code !== "PGRST202" && (bjErr || !bj?.ok)) medsNote += " The backjob details didn't save: the owner or GM can add them on Clinic › Backjobs.";
  }
  // CHRIS Nov 27 (update-0085): a balance after a DP earns 5% of the whole package price.
  if (paid && fd.get("after_dp") === "1") {
    const { data: dp, error: dpErr } = await supabase.rpc("set_after_dp", { p_log: data.id, p_on: true });
    medsNote += dpErr || !dp?.ok ? " The DP balance mark didn't save: ask the owner or GM to tap \"Balance after DP\" on the entry." : " Marked as the balance after a DP (commission on the full price).";
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
  if (pm) {
    medsNote = (data.payment ? ` Payment for ${pm.promo.title}.` : ` ${pm.promo.title}: session ${data.session} of ${data.of}.`) + (data.new ? " Their promo has started: send them the schedule below." : "") + medsNote;
    revalidatePath("/promos");
  }
  const link = pm && data.promo_client ? `/promos/client/${data.promo_client}` : undefined;
  if (data.photos_due) return { link, ok: ("Saved. The lead and assist were asked to add the client photos and waiver; their commission is held until they do.") + medsNote, at: Date.now() };
  const on = p.data.date === manilaToday() ? "" : ` for ${new Date(`${p.data.date}T00:00:00Z`).toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}`;
  if (data.state === "APPROVED") return { link, ok: (paid ? `Saved and approved${on}.` : `Saved${on}. Unpaid visit logged (no commission).`) + medsNote, at: Date.now() };
  return { link, ok: (paid ? "Saved. Waiting for manager sign-off." : "Saved. Unpaid visit logged (no commission).") + medsNote, at: Date.now() };
}

/** update-0087: what went wrong with a promo session, in plain words. */
function promoError(d: { error: string; of?: number; session?: number; balance?: number; ends_on?: string }): string {
  switch (d.error) {
    case "PROMO_USED_UP": return `This client has used all ${d.of} sessions of this item.`;
    case "PROMO_SESSION": return `This client is on session ${d.session} of ${d.of}. Pick that session.`;
    case "PROMO_PAY_LINE": return "Program sessions are already paid for, so they're ₱0. Log any payment on the promo's payment line.";
    case "PROMO_OVERPAID": return `That's more than the client owes. Balance: ${centsToPhp(d.balance ?? 0)}.`;
    case "PROMO_EXPIRED": return `This client's promo ended on ${d.ends_on}. Ask an owner or the GM to extend it on the client's schedule page.`;
    case "PROMO_CLIENT_CLOSED": return "This client's promo is finished or cancelled.";
    case "PROMO_CLIENT_EXISTS": return "This client already has this promo. Pick their name in the list instead of New client.";
    case "PROMO_NOT_RUNNING": return "This promo has ended, so no new clients can start it.";
    case "NOT_PROMO_SERVICE": return "That item isn't part of this client's promo.";
    default: return errorText(d.error);
  }
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

/** CHRIS Nov 27 (update-0085): mark or unmark an entry as the balance paid after a DP (commission on the full price). */
export async function toggleAfterDp(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const id = z.uuid().safeParse(fd.get("id"));
  if (!id.success) return { error: "Could not save. Try again." };
  const on = fd.get("on") === "1";
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("set_after_dp", { p_log: id.data, p_on: on });
  if (error) return { error: error.code === "PGRST202" ? "This needs database update-0085. Run it from your To-Do first." : "Could not save. Try again." };
  if (!data.ok) return { error: data.error === "ALREADY_PAID" ? "This entry's commission is already on a final payslip." : data.error === "NOT_A_BALANCE" ? "Only an amount below the list price can be a balance after a DP." : errorText(data.error) };
  revalidatePath("/services");
  revalidatePath("/me");
  return { ok: on ? `Balance after DP: commission is now ${centsToPhp(data.commission_cents)}.` : `Unmarked: commission is back to ${centsToPhp(data.commission_cents)}.`, at: Date.now() };
}

/** Owners: re-number a month's entries in order once its sales are final (update-0079). */
export async function renumberMonth(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const month = z.string().regex(/^\d{4}-\d{2}$/).safeParse(fd.get("month"));
  if (!month.success) return { error: "Pick a month." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("renumber_service_logs", { p_month: `${month.data}-01` });
  if (error) return { error: error.code === "PGRST202" ? "Entry numbers need database update-0079. Run it from your To-Do first." : "Could not re-number. Try again." };
  if (!data.ok) return { error: errorText(data.error) };
  revalidatePath("/services");
  return { ok: `${data.entries} entries re-numbered in order.`, at: Date.now() };
}
