"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { centsToPhp, CsvError, parseHistoricalSalesCsv, phpToCents } from "@/lib/csv";
import { branchesFor, errorText, requireAccess } from "@/lib/access";
import { detectBranchCode, keepLoadableRows } from "@/lib/quickImport";

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

export type QuickResult = { file: string; ok: boolean; text: string; id?: string };
export type QuickState = { error?: string; results?: QuickResult[] } | undefined;

/**
 * Pre-launch quick upload (owner's choice, 2026-11-23): several files at once, branch read from the
 * file name, no typed totals. Each file is staged and published straight away with the file's own
 * count and total, so it is still hashed, stored row by row, reversible and audited. Only works while
 * organizations.require_second_signoff is false, for an MFA-verified OWNER (the database checks too).
 */
export async function quickImport(_prev: QuickState, fd: FormData): Promise<QuickState> {
  const { supabase, access, branches } = await requireAccess();
  const { data: org } = await supabase.from("organizations").select("require_second_signoff").maybeSingle();
  if (org?.require_second_signoff !== false) return { error: "Quick upload is off. Use the normal upload with totals." };
  const owned = branchesFor(access, branches, ["OWNER"]);
  if (owned.length === 0) return { error: errorText("FORBIDDEN") };
  const files = fd.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length === 0) return { error: "Choose one or more CSV files." };
  if (files.length > 20) return { error: "Upload at most 20 files at a time." };

  const results: QuickResult[] = [];
  for (const file of files) {
    const name = file.name.slice(0, 200);
    const fail = (text: string, id?: string) => results.push({ file: name, ok: false, text, id });
    if (!/\.csv$/i.test(file.name)) { fail("Not a .csv file, skipped."); continue; }
    if (file.size > MAX_BYTES) { fail("Larger than 5 MB, skipped."); continue; }
    const text = await file.text();
    let parsed;
    try {
      parsed = parseHistoricalSalesCsv(text);
    } catch (e) {
      fail(errorText(e instanceof CsvError ? e.message : undefined));
      continue;
    }
    const code = detectBranchCode(file.name, parsed);
    const branch = owned.find((b) => b.code === code);
    if (!branch) { fail("Couldn't tell the branch from the file name. Put QC-Main, Fairview, Marikina or Sta-Maria in the name."); continue; }
    const { rows, cents, skipped } = keepLoadableRows(parsed);
    if (rows.length === 0) { fail("No readable sales rows."); continue; }

    const { data: st, error: e1 } = await supabase.rpc("stage_historical_sales", {
      p_branch: branch.id, p_filename: name, p_csv: text, p_rows: rows,
      p_expected_rows: rows.length, p_expected_gross_cents: cents,
    });
    if (e1 || !st?.ok) { fail(e1 ? "Upload failed. Try again." : errorText(st.error)); continue; }
    if (st.duplicate && st.state === "PUBLISHED") {
      results.push({ file: name, ok: true, text: `${branch.name}: already loaded earlier, nothing added.`, id: st.id });
      continue;
    }
    const { data: pub, error: e2 } = await supabase.rpc("publish_historical_batch", {
      p_batch: st.id, p_expected_rows: rows.length, p_expected_gross_cents: cents,
    });
    if (e2 || !pub?.ok) {
      const why = e2 ? "Publishing failed." : errorText(pub.error);
      // Free the file so it can be uploaded again after a fix; the attempt stays in the audit log.
      await supabase.rpc("cancel_staged_batch", { p_batch: st.id, p_reason: `Quick upload could not publish: ${why}`.slice(0, 500) });
      fail(`${branch.name}: ${why}`, st.id);
      continue;
    }
    const total = centsToPhp(cents);
    results.push({
      file: name, ok: true, id: st.id,
      text: `${branch.name}: ${rows.length} days loaded, ${total}${skipped ? `, ${skipped} unreadable rows skipped` : ""}.`,
    });
  }
  revalidatePath("/imports");
  revalidatePath("/");
  return { results };
}
