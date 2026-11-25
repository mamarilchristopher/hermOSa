"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { errorText } from "@/lib/access";

export type PayState = { ok?: string; error?: string; n?: number } | undefined;

const cents = (v: FormDataEntryValue | null): number | null | "bad" => {
  const t = String(v ?? "").replace(/[,₱\s]/g, "");
  if (!t) return null;
  return /^\d+(\.\d{1,2})?$/.test(t) ? Math.round(Number(t) * 100) : "bad";
};
const missing = (code?: string) => (code === "PGRST202" || code === "42P01" ? "The owner needs to run update-0046 in Supabase first." : "Could not save. Try again.");

/** Pay rate and switches for one staff member. Owners and the GM (the database checks). */
export async function savePaySettings(prev: PayState, fd: FormData): Promise<PayState> {
  const n = (prev?.n ?? 0) + 1;
  const emp = z.uuid().safeParse(String(fd.get("employee") ?? ""));
  if (!emp.success) return { error: "Refresh the page and try again.", n };
  const basis = String(fd.get("basis")) === "DAILY" ? "DAILY" : "MONTHLY";
  const rate = cents(fd.get("rate")), allowance = cents(fd.get("allowance"));
  if (rate === "bad" || rate == null) return { error: "Type the rate in pesos, like 18000.", n };
  if (allowance === "bad") return { error: "The allowance is a peso amount, like 500.", n };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("save_pay_settings", {
    p_employee: emp.data, p_basis: basis, p_rate_cents: rate, p_allowance_cents: allowance ?? 0,
    p_statutory: fd.get("statutory") === "on", p_tax: fd.get("tax") === "on", p_deduct_lates: fd.get("lates") === "on",
  });
  if (error) return { error: missing(error.code), n };
  if (!data?.ok) return { error: errorText(data?.error), n };
  revalidatePath("/payroll");
  return { ok: "Saved.", n };
}

/** Opens (or recomputes) the payroll for the cutoff holding the date, then shows it. */
export async function openPayroll(fd: FormData) {
  const date = String(fd.get("date") ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
  const supabase = await createClient();
  const { data } = await supabase.rpc("open_payroll", { p_date: date });
  revalidatePath("/payroll");
  if (data?.ok) redirect(`/payroll?run=${data.id}`);
}

export async function finalizePayroll(prev: PayState, fd: FormData): Promise<PayState> {
  const n = (prev?.n ?? 0) + 1;
  const run = z.uuid().safeParse(String(fd.get("run") ?? ""));
  if (!run.success) return { error: "Refresh the page and try again.", n };
  if (fd.get("confirm") !== "on") return { error: "Tick the box to confirm the payslips are checked.", n };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("finalize_payroll", { p_run: run.data });
  if (error) return { error: missing(error.code), n };
  if (!data?.ok) return { error: errorText(data?.error), n };
  revalidatePath("/payroll"); revalidatePath("/payslips");
  return { ok: `Final. ${data.payslips} payslips sent to staff.`, n };
}

export async function addAdjustment(prev: PayState, fd: FormData): Promise<PayState> {
  const n = (prev?.n ?? 0) + 1;
  const run = z.uuid().safeParse(String(fd.get("run") ?? "")), emp = z.uuid().safeParse(String(fd.get("employee") ?? ""));
  if (!run.success || !emp.success) return { error: "Refresh the page and try again.", n };
  const amount = cents(fd.get("amount"));
  const label = String(fd.get("label") ?? "").trim();
  if (label.length < 2) return { error: "Say what it's for, like \"Overtime 3 hrs\" or \"Cash advance Nov 3 (1st deduction)\".", n };
  if (amount === "bad" || !amount) return { error: "Type the amount in pesos, like 500.", n };
  const kind = String(fd.get("kind")) === "DEDUCTION" ? "DEDUCTION" : "EARNING";
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("add_payslip_adjustment", {
    p_run: run.data, p_employee: emp.data, p_kind: kind, p_label: label, p_amount_cents: amount, p_taxable: fd.get("nontax") !== "on",
  });
  if (error) return { error: missing(error.code), n };
  if (!data?.ok) return { error: errorText(data?.error), n };
  revalidatePath("/payroll"); revalidatePath("/payslips");
  return { ok: "Added.", n };
}

export async function removeAdjustment(fd: FormData) {
  const id = z.uuid().safeParse(String(fd.get("id") ?? ""));
  if (!id.success) return;
  const supabase = await createClient();
  await supabase.rpc("remove_payslip_adjustment", { p_id: id.data });
  revalidatePath("/payroll"); revalidatePath("/payslips");
}

export async function saveHoliday(prev: PayState, fd: FormData): Promise<PayState> {
  const n = (prev?.n ?? 0) + 1;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("save_holiday", {
    p_date: String(fd.get("date") ?? "") || null, p_name: String(fd.get("name") ?? ""), p_kind: String(fd.get("kind") ?? ""),
  });
  if (error) return { error: error.code === "22007" ? errorText("INVALID_HOLIDAY") : missing(error.code), n };
  if (!data?.ok) return { error: errorText(data?.error), n };
  revalidatePath("/payroll");
  return { ok: "Saved.", n };
}

export async function deleteHoliday(fd: FormData) {
  const d = String(fd.get("date") ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
  const supabase = await createClient();
  await supabase.rpc("delete_holiday", { p_date: d });
  revalidatePath("/payroll");
}
