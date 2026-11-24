"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { errorText, requireAccess } from "@/lib/access";
import { addDays } from "@/lib/insights";
import { normalizeRules, suggestWeek as suggest, type Fixed } from "@/lib/scheduleAuto";
import { branchShort } from "@/lib/schedule";

export type ActionState = { error?: string; ok?: string; at?: number } | undefined;

const date = z.iso.date();
const time = z.string().regex(/^\d{2}:\d{2}$/);

async function call(fn: string, args: Record<string, unknown>, okText: string): Promise<ActionState> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc(fn, args);
  if (error) return { error: error.code === "PGRST202" ? `The owner needs to run update-${["save_day", "copy_last_week"].includes(fn) ? "0024" : fn.includes("schedule_rules") ? "0025" : "0022"} in Supabase first.` : "Could not save. Try again." };
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

export async function copyLastWeek(_p: ActionState, fd: FormData): Promise<ActionState> {
  const m = date.safeParse(fd.get("monday"));
  if (!m.success) return { error: "Try again." };
  return call("copy_last_week", { p_monday: m.data }, "Copied last week as a draft. Adjust any day, then publish.");
}

const DayRow = z.object({ employee: z.uuid(), status: z.union([z.uuid(), z.enum(["OFF", "VL", "SL", "ABSENT"])]), start: time.optional(), end: time.optional() });
export async function saveDay(_p: ActionState, fd: FormData): Promise<ActionState> {
  const d = date.safeParse(fd.get("date"));
  let rows: unknown;
  try { rows = JSON.parse(String(fd.get("rows") ?? "[]")); } catch { return { error: "Try again." }; }
  const p = z.array(DayRow).max(100).safeParse(rows);
  if (!d.success || !p.success) return { error: "Pick a branch, Off or leave for each person." };
  if (p.data.some((r) => !["OFF", "VL", "SL", "ABSENT"].includes(r.status) && (!r.start || !r.end || r.end <= r.start))) return { error: "Check the hours." };
  return call("save_day", { p_date: d.data, p_rows: p.data }, "Saved.");
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

type WkPerson = { id: string; branch_id: string | null; can_edit: boolean; pattern: { branch_id: string; days_off: number[]; start: string; end: string } | null };
type WkShift = { employee_id: string; date: string; off: boolean; branch_id: string | null; state: string; leave?: string | null };

/** Suggest a week: plans every unpublished day from the rules; published and leave days are kept. */
export async function suggestWeekAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const m = date.safeParse(fd.get("monday"));
  if (!m.success) return { error: "Try again." };
  const { supabase, branches } = await requireAccess();
  const clinics = branches.filter((b) => b.kind === "CLINIC");
  const [{ data: wk, error }, { data: prev }, { data: rulesRaw, error: rErr }] = await Promise.all([
    supabase.rpc("week_schedule", { p_monday: m.data }),
    supabase.rpc("week_schedule", { p_monday: addDays(m.data, -7) }),
    supabase.rpc("schedule_rules"),
  ]);
  if (error || rErr) return { error: rErr?.code === "PGRST202" ? "The owner needs to run update-0025 in Supabase first." : "Could not load the week. Try again." };
  const w = wk as { people: WkPerson[]; shifts: WkShift[] };
  const people = w.people.filter((p) => p.can_edit).map((p) => ({ id: p.id, home: p.pattern?.branch_id ?? p.branch_id,
    daysOff: p.pattern?.days_off, start: p.pattern?.start, end: p.pattern?.end }));
  if (!people.length) return { error: "No staff to schedule." };
  const dayIdx = (d: string, monday: string) => Math.round((Date.parse(d) - Date.parse(monday)) / 86400000);
  const asFixed = (list: WkShift[], monday: string): Fixed[] => list.map((s) => ({ employee: s.employee_id, day: dayIdx(s.date, monday),
    status: s.leave ?? (s.off ? "OFF" : s.branch_id ?? "OFF") }));
  const keep = w.shifts.filter((s) => s.state === "PUBLISHED" || s.leave);
  const seed = Number(fd.get("seed")) || Number(m.data.replace(/-/g, ""));
  const rules = normalizeRules(rulesRaw, clinics.map((b) => b.id));
  const { days, short } = suggest({ people, branches: clinics.map((b) => b.id), rules, fixed: asFixed(keep, m.data), seed,
    lastWeek: asFixed(((prev as { shifts: WkShift[] } | null)?.shifts ?? []), addDays(m.data, -7)) });
  for (let i = 0; i < 7; i++) {
    if (!days[i].length) continue;
    const { data, error: e } = await supabase.rpc("save_day", { p_date: addDays(m.data, i), p_rows: days[i] });
    if (e || !data?.ok) return { error: e ? "Could not save the suggestion. Try again." : errorText(data?.error) };
  }
  revalidatePath("/schedule");
  const name = (id: string) => branchShort(clinics.find((b) => b.id === id)?.name ?? "");
  const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return { ok: short.length
    ? `Suggested, but not enough people for: ${short.slice(0, 4).map((x) => `${DOW[x.day]} ${name(x.branch)}`).join(", ")}${short.length > 4 ? ", and more" : ""}. Adjust, then publish.`
    : "Suggested a week. Check it, change any day, then Publish.", at: Date.now() };
}

export async function saveRules(_p: ActionState, fd: FormData): Promise<ActionState> {
  let raw: unknown;
  try { raw = JSON.parse(String(fd.get("rules") ?? "{}")); } catch { return { error: "Try again." }; }
  const { branches } = await requireAccess();
  const rules = normalizeRules(raw, branches.filter((b) => b.kind === "CLINIC").map((b) => b.id));
  return call("save_schedule_rules", { p_rules: rules }, "Rules saved.");
}
