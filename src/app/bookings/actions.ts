"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { errorText } from "@/lib/access";
import { isIsoDate } from "@/lib/dates";

export type BookingState = { ok?: string; error?: string; n?: number } | undefined;

const missing = (code?: string) => code === "PGRST202" || code === "42P01";
const NEEDS_SQL = "The owner needs to run update-0040 and update-0042 in Supabase first.";
const PLATFORMS = ["FACEBOOK", "INSTAGRAM", "CALL", "SMS", "WALK_IN", "OTHER"];

export async function addBooking(prev: BookingState, fd: FormData): Promise<BookingState> {
  const s = (k: string) => String(fd.get(k) ?? "").trim();
  const client = s("client"), services = s("services"), date = s("date"), branch = s("branch"), platform = s("platform") || "FACEBOOK";
  const time = s("time"), dp = s("dp").replace(/[,₱\s]/g, ""), value = s("value").replace(/[,₱\s]/g, "");
  const n = (prev?.n ?? 0) + 1;
  if (client.length < 2) return { error: "Write the client's name.", n };
  if (services.length < 2) return { error: "Write the service.", n };
  if (!isIsoDate(date)) return { error: "Choose the visit date.", n };
  if (!z.uuid().safeParse(branch).success) return { error: "Choose the branch.", n };
  if (!PLATFORMS.includes(platform)) return { error: "Choose where they booked.", n };
  if (time && !/^\d{2}:\d{2}$/.test(time)) return { error: "Check the time.", n };
  if (dp && !/^\d+(\.\d{1,2})?$/.test(dp)) return { error: "Down payment should be a peso amount, like 500.", n };
  if (value && !/^\d+(\.\d{1,2})?$/.test(value)) return { error: "Expected value should be a peso amount, like 8999.", n };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("save_booking", {
    p_id: null, p_client: client, p_contact: s("contact") || null, p_platform: platform, p_services: services,
    p_date: date, p_time: time || null, p_branch: branch, p_deposit_cents: dp ? Math.round(Number(dp) * 100) : null,
    p_deposit_date: null, p_follow_up: fd.get("follow_up") === "on", p_note: s("note") || null,
    p_expected_cents: value ? Math.round(Number(value) * 100) : null,
  });
  if (error) return { error: missing(error.code) ? NEEDS_SQL : "Could not save. Try again.", n };
  if (!data?.ok) return { error: errorText(data?.error), n };
  revalidatePath("/bookings"); revalidatePath("/me");
  return { ok: `Booked: ${client}.`, n };
}

export async function setStatus(_prev: BookingState, fd: FormData): Promise<BookingState> {
  const id = z.uuid().safeParse(fd.get("id"));
  const status = String(fd.get("decision") ?? "");
  const newDate = String(fd.get("new_date") ?? "");
  const note = String(fd.get("note") ?? "").trim();
  if (!id.success) return { error: "Refresh the page and try again." };
  if (!["ARRIVED", "DONE", "UNRESPONSIVE", "RESCHEDULED", "CONFIRMED", "CANCELLED", "BOOKED", "NOTE"].includes(status)) return { error: "Tap a status." };
  if (status === "RESCHEDULED" && !isIsoDate(newDate)) return { error: "Choose the new date first." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("set_booking_status", { p_id: id.data, p_status: status, p_new_date: status === "RESCHEDULED" ? newDate : null, p_note: note || null });
  if (error) return { error: missing(error.code) ? NEEDS_SQL : "Could not save. Try again." };
  if (!data?.ok) return { error: errorText(data?.error) };
  revalidatePath("/bookings"); revalidatePath("/me");
  return { ok: "Saved." };
}

/** update-0081: log one follow-up of an Unresponsive booking, with its outcome. CSRs, owners and the GM. */
export async function logFollowUp(_prev: BookingState, fd: FormData): Promise<BookingState> {
  const id = z.uuid().safeParse(fd.get("id"));
  const outcome = String(fd.get("decision") ?? "");
  const channel = String(fd.get("channel") ?? "");
  const newDate = String(fd.get("new_date") ?? "");
  const note = String(fd.get("note") ?? "").trim();
  if (!id.success) return { error: "Refresh the page and try again." };
  if (!["CALL", "FACEBOOK", "SMS", "OTHER"].includes(channel)) return { error: "Choose how you contacted them." };
  if (!["STILL_UNRESPONSIVE", "REBOOKED", "CANCELLED"].includes(outcome)) return { error: "Tap what happened." };
  if (outcome === "REBOOKED" && !isIsoDate(newDate)) return { error: "Choose the new visit date first." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("log_booking_followup", { p_booking: id.data, p_channel: channel, p_outcome: outcome, p_new_date: outcome === "REBOOKED" ? newDate : null, p_note: note || null });
  if (error) return { error: missing(error.code) ? "The owner needs to run update-0081 in Supabase first." : "Could not save. Try again." };
  if (!data?.ok) return { error: data?.error === "NOT_UNRESPONSIVE" ? "Someone already updated this booking. Refresh the page." : errorText(data?.error) };
  revalidatePath("/bookings"); revalidatePath("/bookings/followups"); revalidatePath("/me");
  return { ok: outcome === "REBOOKED" ? "Rebooked." : outcome === "CANCELLED" ? "Cancelled." : "Follow-up logged." };
}
