"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { errorText } from "@/lib/access";

export type ActionState = { error?: string; ok?: string; at?: number } | undefined;

const date = z.iso.date();
const time = z.string().regex(/^\d{2}:\d{2}$/);

async function call(fn: string, args: Record<string, unknown>, okText: string): Promise<ActionState> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc(fn, args);
  if (error) return { error: error.code === "PGRST202" ? "The owner needs to run update-0022 in Supabase first." : "Could not save. Try again." };
  if (!data?.ok) return { error: errorText(data?.error ?? "UNKNOWN") };
  revalidatePath("/schedule");
  revalidatePath("/me");
  return { ok: okText, at: Date.now() };
}

export async function generateWeek(_p: ActionState, fd: FormData): Promise<ActionState> {
  const m = date.safeParse(fd.get("monday"));
  if (!m.success) return { error: "Try again." };
  return call("generate_week", { p_monday: m.data }, "Week filled from everyone's usual schedule. Adjust any day, then publish.");
}

export async function publishWeek(_p: ActionState, fd: FormData): Promise<ActionState> {
  const m = date.safeParse(fd.get("monday"));
  if (!m.success) return { error: "Try again." };
  return call("publish_week", { p_monday: m.data }, "Published. Staff can see the week and got a notice.");
}

const Shift = z.object({ employee: z.uuid(), date, off: z.enum(["0", "1"]), branch: z.union([z.uuid(), z.literal("")]), start: z.union([time, z.literal("")]), end: z.union([time, z.literal("")]), note: z.string().max(200).optional() });
export async function saveShift(_p: ActionState, fd: FormData): Promise<ActionState> {
  const p = Shift.safeParse(Object.fromEntries(["employee", "date", "off", "branch", "start", "end", "note"].map((k) => [k, fd.get(k) ?? undefined])));
  if (!p.success) return { error: "Pick a branch and the hours, or Day off." };
  const off = p.data.off === "1";
  if (!off && (!p.data.branch || !p.data.start || !p.data.end)) return { error: "Pick a branch and the hours, or Day off." };
  return call("save_shift", { p_employee: p.data.employee, p_date: p.data.date, p_off: off, p_branch: off ? null : p.data.branch,
    p_start: off ? null : p.data.start, p_end: off ? null : p.data.end, p_note: p.data.note || null }, "Saved.");
}

const Pattern = z.object({ employee: z.uuid(), branch: z.uuid(), start: time, end: time });
export async function savePattern(_p: ActionState, fd: FormData): Promise<ActionState> {
  const p = Pattern.safeParse(Object.fromEntries(["employee", "branch", "start", "end"].map((k) => [k, fd.get(k) ?? undefined])));
  if (!p.success) return { error: "Pick the branch and hours." };
  const off = fd.getAll("off").map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  return call("save_schedule_pattern", { p_employee: p.data.employee, p_branch: p.data.branch, p_days_off: off, p_start: p.data.start, p_end: p.data.end }, "Saved.");
}

const Req = z.object({ kind: z.enum(["SWAP", "DAY_OFF"]), date, other: z.union([z.uuid(), z.literal("")]).optional(), other_date: z.union([date, z.literal("")]).optional(), reason: z.string().max(300).optional() });
export async function requestChange(_p: ActionState, fd: FormData): Promise<ActionState> {
  const p = Req.safeParse(Object.fromEntries(["kind", "date", "other", "other_date", "reason"].map((k) => [k, fd.get(k) ?? undefined])));
  if (!p.success) return { error: "Fill in the days." };
  if (p.data.kind === "SWAP" && !p.data.other) return { error: "Pick who you're swapping with." };
  if (p.data.kind === "DAY_OFF" && !p.data.other_date) return { error: "Pick your new day off." };
  return call("request_schedule_change", { p_kind: p.data.kind, p_date: p.data.date, p_other_employee: p.data.other || null,
    p_other_date: p.data.other_date || null, p_reason: p.data.reason || null }, "Sent. A manager will approve it.");
}

export async function decideRequest(_p: ActionState, fd: FormData): Promise<ActionState> {
  const id = z.uuid().safeParse(fd.get("id"));
  if (!id.success) return { error: "Try again." };
  const approve = fd.get("decision") === "approve";
  return call("decide_schedule_request", { p_id: id.data, p_approve: approve, p_note: String(fd.get("note") ?? "") || null }, approve ? "Approved" : "Not approved");
}

export async function cancelRequest(_p: ActionState, fd: FormData): Promise<ActionState> {
  const id = z.uuid().safeParse(fd.get("id"));
  if (!id.success) return { error: "Try again." };
  return call("cancel_schedule_request", { p_id: id.data }, "Cancelled");
}
