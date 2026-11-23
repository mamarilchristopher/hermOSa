"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { CsvError, parseHistoricalSalesCsv, phpToCents } from "@/lib/csv";
import { errorText } from "@/lib/access";

export type FormState = { error?: string; ok?: string } | undefined;
const MAX_BYTES = 5 * 1024 * 1024;

const pesos = z.string().trim().transform((v, ctx) => {
  try {
    return phpToCents(v.replace(/,/g, ""));
  } catch {
    ctx.addIssue({ code: "custom", message: "BAD_EXPECTED_TOTAL" });
    return z.NEVER;
  }
});

const Stage = z.object({
  branch: z.uuid(),
  expectedRows: z.coerce.number().int().min(0).max(1_000_000),
  expectedTotal: pesos,
});

export async function stageImport(_prev: FormState, fd: FormData): Promise<FormState> {
  const parsed = Stage.safeParse({ branch: fd.get("branch"), expectedRows: fd.get("expectedRows"), expectedTotal: fd.get("expectedTotal") });
  if (!parsed.success) return { error: errorText("BAD_EXPECTED_TOTAL") };
  const file = fd.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose a CSV file." };
  if (file.size > MAX_BYTES) return { error: "The file is larger than 5 MB. Split it by month." };
  if (!/\.csv$/i.test(file.name)) return { error: "Upload a .csv file (in Excel: File > Save As > CSV UTF-8)." };
  const text = await file.text();
  let rows;
  try {
    rows = parseHistoricalSalesCsv(text);
  } catch (e) {
    return { error: errorText(e instanceof CsvError ? e.message : undefined) };
  }
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("stage_historical_sales", {
    p_branch: parsed.data.branch,
    p_filename: file.name.slice(0, 200),
    p_csv: text,
    p_rows: rows,
    p_expected_rows: parsed.data.expectedRows,
    p_expected_gross_cents: parsed.data.expectedTotal,
  });
  if (error) return { error: "Upload failed. Try again." };
  if (!data.ok) return { error: errorText(data.error) };
  revalidatePath("/imports");
  redirect(`/imports/${data.id}${data.duplicate ? "?duplicate=1" : ""}`);
}

const Publish = z.object({ batch: z.uuid(), expectedRows: z.coerce.number().int().min(0), expectedTotal: pesos });

export async function publishImport(_prev: FormState, fd: FormData): Promise<FormState> {
  const parsed = Publish.safeParse({ batch: fd.get("batch"), expectedRows: fd.get("expectedRows"), expectedTotal: fd.get("expectedTotal") });
  if (!parsed.success) return { error: errorText("BAD_EXPECTED_TOTAL") };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("publish_historical_batch", {
    p_batch: parsed.data.batch,
    p_expected_rows: parsed.data.expectedRows,
    p_expected_gross_cents: parsed.data.expectedTotal,
  });
  if (error) return { error: "Sign-off failed. Try again." };
  if (!data.ok) return { error: errorText(data.error) };
  revalidatePath(`/imports/${parsed.data.batch}`);
  return { ok: "Signed off and published. It now counts in the dashboard." };
}

const Reverse = z.object({ batch: z.uuid(), reason: z.string().trim().min(8).max(500) });

export async function reverseImport(_prev: FormState, fd: FormData): Promise<FormState> {
  const parsed = Reverse.safeParse({ batch: fd.get("batch"), reason: fd.get("reason") });
  if (!parsed.success) return { error: errorText("REASON_REQUIRED") };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("reverse_historical_batch", { p_batch: parsed.data.batch, p_reason: parsed.data.reason });
  if (error) return { error: "Reversal failed. Try again." };
  if (!data.ok) return { error: errorText(data.error) };
  revalidatePath(`/imports/${parsed.data.batch}`);
  return { ok: "Reversed. The original rows and audit trail are kept." };
}

export async function discardImport(_prev: FormState, fd: FormData): Promise<FormState> {
  const parsed = Reverse.safeParse({ batch: fd.get("batch"), reason: fd.get("reason") });
  if (!parsed.success) return { error: errorText("REASON_REQUIRED") };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("cancel_staged_batch", { p_batch: parsed.data.batch, p_reason: parsed.data.reason });
  if (error) return { error: "Could not discard. Try again." };
  if (!data.ok) return { error: errorText(data.error) };
  revalidatePath(`/imports/${parsed.data.batch}`);
  revalidatePath("/imports");
  return { ok: "Discarded. You can upload the corrected file or totals now." };
}
