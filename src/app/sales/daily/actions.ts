"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { errorText } from "@/lib/access";
import { readMoney } from "@/lib/tracker";

export type DayState = { error?: string; ok?: string; n?: number } | undefined;

const MORE: Record<string, string> = {
  ROWS_REJECTED: "That day already has a total or is waiting for sign-off. Refresh the page.",
  NOTHING_TO_CORRECT: "That day has no total yet. Enter it instead.",
  SAME_AMOUNT: "That's the amount already recorded.",
  CORRECTION_PENDING: "A correction for that day is already waiting for sign-off.",
  NOTE_REQUIRED: "Write why you're rejecting it.",
  SELF_APPROVAL_DENIED: "Someone other than the person who asked has to approve this.",
  REASON_REQUIRED: "Give a reason of at least 8 characters.",
};
const say = (code: string) => MORE[code] ?? errorText(code);
const done = () => { revalidatePath("/sales/daily"); revalidatePath("/"); revalidatePath("/sales/missing"); };
const centsOf = (v: FormDataEntryValue | null) => {
  const c = readMoney(String(v ?? ""));
  return c === null || Number.isNaN(c) || c <= 0 ? null : c;
};

const Day = z.object({ branch: z.uuid(), date: z.iso.date() });

export async function enterDay(prev: DayState, fd: FormData): Promise<DayState> {
  const n = (prev?.n ?? 0) + 1;
  const p = Day.safeParse({ branch: fd.get("branch"), date: fd.get("date") });
  const cents = centsOf(fd.get("amount"));
  if (!p.success) return { error: "Refresh the page and try again.", n };
  if (cents === null) return { error: "Enter the day's total, e.g. 45,200 (use Missing days for a closed day).", n };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("record_daily_sales", {
    p_branch: p.data.branch, p_rows: [{ date: p.data.date, cents }], p_source: "Daily sales",
  });
  if (error) return { error: `Could not save: ${error.message}`, n };
  if (!data.ok) return { error: say(data.error), n };
  done();
  return { ok: data.state === "PUBLISHED" ? "Saved" : "Saved, waiting for sign-off", n };
}

export async function correctDay(prev: DayState, fd: FormData): Promise<DayState> {
  const n = (prev?.n ?? 0) + 1;
  const p = Day.safeParse({ branch: fd.get("branch"), date: fd.get("date") });
  const cents = centsOf(fd.get("amount"));
  const reason = String(fd.get("reason") ?? "").trim();
  if (!p.success) return { error: "Refresh the page and try again.", n };
  if (cents === null) return { error: "Enter the correct total.", n };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("request_sales_correction", {
    p_branch: p.data.branch, p_date: p.data.date, p_cents: cents, p_reason: reason,
  });
  if (error) return { error: `Could not save: ${error.message}`, n };
  if (!data.ok) return { error: say(data.error), n };
  done();
  return { ok: data.state === "APPLIED" ? "Corrected" : "Sent for sign-off", n };
}

export async function decideCorrection(prev: DayState, fd: FormData): Promise<DayState> {
  const n = (prev?.n ?? 0) + 1;
  const id = z.uuid().safeParse(fd.get("id"));
  if (!id.success) return { error: "Refresh the page and try again.", n };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("decide_sales_correction", {
    p_id: id.data, p_approve: fd.get("decision") === "approve", p_note: String(fd.get("note") ?? "") || null,
  });
  if (error) return { error: `Could not save: ${error.message}`, n };
  if (!data.ok) return { error: say(data.error), n };
  done();
  return { ok: data.state === "APPLIED" ? "Approved and applied" : "Rejected", n };
}

/** Upload: what the OS holds for a date range (read-only). */
export async function existingDays(start: string, end: string) {
  if (!z.iso.date().safeParse(start).success || !z.iso.date().safeParse(end).success) return { ok: false as const, error: "BAD_REQUEST" };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("daily_sales_status", { p_start: start, p_end: end });
  if (error || !data?.ok) return { ok: false as const, error: error?.message ?? data?.error ?? "UNKNOWN" };
  return data as { ok: true; second_signoff: boolean; branches: { id: string; code: string; name: string; can_enter: boolean; self_publish: boolean }[];
    days: [string, string, number | null, string | null, boolean, number | null][] };
}

const Load = z.object({ branch: z.uuid(), rows: z.array(z.object({ date: z.iso.date(), cents: z.number().int().positive() })).min(1).max(400), file: z.string().max(120) });

/** Upload: load the new days for one branch. All or nothing per branch. */
export async function loadDays(input: unknown) {
  const p = Load.safeParse(input);
  if (!p.success) return { ok: false, error: "BAD_REQUEST" };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("record_daily_sales", {
    p_branch: p.data.branch, p_rows: p.data.rows, p_source: `Tracker upload: ${p.data.file}`,
  });
  if (error) return { ok: false, error: error.message };
  if (!data.ok) return { ok: false, error: data.error, problems: data.problems as { date: string; error: string }[] | undefined };
  done();
  return { ok: true, state: data.state as string, rows: data.rows as number };
}

const Fix = z.object({ branch: z.uuid(), date: z.iso.date(), cents: z.number().int().positive(), reason: z.string().trim().min(8).max(500) });

/** Upload: replace a recorded day with the file's amount (a correction, with a reason). */
export async function correctFromUpload(input: unknown) {
  const p = Fix.safeParse(input);
  if (!p.success) return { ok: false, error: "REASON_REQUIRED" };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("request_sales_correction", {
    p_branch: p.data.branch, p_date: p.data.date, p_cents: p.data.cents, p_reason: p.data.reason,
  });
  if (error) return { ok: false, error: error.message };
  if (!data.ok) return { ok: false, error: data.error };
  done();
  return { ok: true, state: data.state as string };
}

const Grid = z.object({
  entries: z.array(z.object({ branch: z.uuid(), date: z.iso.date(), cents: z.number().int().positive() })).max(400),
  fixes: z.array(z.object({ branch: z.uuid(), date: z.iso.date(), cents: z.number().int().positive() })).max(100),
  reason: z.string().trim().max(500),
});
export type GridResult = { ok: boolean; saved: number; waiting: number; failed: { branch: string; date: string; error: string }[] };

/** Month grid: save every typed cell at once. New days per branch go in one batch; changed days are corrections. */
export async function saveGrid(input: unknown): Promise<GridResult> {
  const p = Grid.safeParse(input);
  if (!p.success) return { ok: false, saved: 0, waiting: 0, failed: [{ branch: "", date: "", error: "Check the amounts and try again." }] };
  if (p.data.fixes.length > 0 && p.data.reason.length < 8) {
    return { ok: false, saved: 0, waiting: 0, failed: [{ branch: "", date: "", error: "Changing a recorded day needs a reason (at least 8 characters)." }] };
  }
  const supabase = await createClient();
  const out: GridResult = { ok: true, saved: 0, waiting: 0, failed: [] };
  const byBranch = new Map<string, { date: string; cents: number }[]>();
  for (const e of p.data.entries) byBranch.set(e.branch, [...(byBranch.get(e.branch) ?? []), { date: e.date, cents: e.cents }]);
  for (const [branch, rows] of byBranch) {
    const { data, error } = await supabase.rpc("record_daily_sales", { p_branch: branch, p_rows: rows, p_source: "Daily sales" });
    if (error || !data?.ok) {
      const problems = (data?.problems ?? []) as { date: string; error: string }[];
      for (const r of rows) {
        const pr = problems.find((x) => x.date === r.date);
        out.failed.push({ branch, date: r.date, error: pr ? say(pr.error === "DAY_ALREADY_RECORDED" ? "ROWS_REJECTED" : pr.error) : error?.message ?? say(data?.error ?? "UNKNOWN") });
      }
      continue;
    }
    if (data.state === "PUBLISHED") out.saved += rows.length; else out.waiting += rows.length;
  }
  for (const f of p.data.fixes) {
    const { data, error } = await supabase.rpc("request_sales_correction", { p_branch: f.branch, p_date: f.date, p_cents: f.cents, p_reason: p.data.reason });
    if (error || !data?.ok) out.failed.push({ branch: f.branch, date: f.date, error: error?.message ?? say(data.error) });
    else if (data.state === "APPLIED") out.saved++; else out.waiting++;
  }
  out.ok = out.failed.length === 0;
  done();
  return out;
}
