"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

const NEEDS_SQL = "The owner needs to run update-0100 in Supabase first.";
const ERR: Record<string, string> = {
  FORBIDDEN: "Only owners, the GM and Finance can do this.", BAD_AMOUNT: "Type the amount in pesos.", BAD_DATE: "Pick the date it was paid.",
  BAD_CATEGORY: "Pick a category.", BAD_REQUEST: "Check the fields and try again.", TOO_MANY: "Up to 5 receipts per expense.",
  PHOTO_NOT_UPLOADED: "A receipt didn't finish uploading. Try again.", NOT_FOUND: "That expense was removed or changed. Refresh the page.",
  REASON_REQUIRED: "Say why it's being removed.", DUPLICATE: "That category already exists.",
};
const back = (fd: FormData, q: Record<string, string>) => {
  const p = new URLSearchParams();
  const m = String(fd.get("month") ?? ""), b = String(fd.get("scope") ?? "");
  if (/^\d{4}-\d{2}$/.test(m)) p.set("month", m);
  if (/^[A-Z_]{2,20}$|^company$/.test(b)) p.set("branch", b);
  for (const [k, v] of Object.entries(q)) p.set(k, v);
  return `/business/expenses?${p.toString()}`;
};
const pesos = (v: FormDataEntryValue | null) => {
  const t = String(v ?? "").replace(/[₱,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
};
const fail = (fd: FormData, error: { code?: string } | null, code?: string): never =>
  redirect(back(fd, { err: error?.code === "PGRST202" || error?.code === "42P01" ? NEEDS_SQL : ERR[code ?? ""] ?? "Could not save. Try again." }));

/** Add or correct an expense. Receipts are uploaded by the browser first (expense-receipts/<org>/<id>.<ext>). */
export async function saveExpense(fd: FormData) {
  const amount = pesos(fd.get("amount"));
  if (amount === null || amount < 1) fail(fd, null, "BAD_AMOUNT");
  let receipts: string[] = [];
  try { receipts = JSON.parse(String(fd.get("receipts") ?? "[]")); } catch { receipts = []; }
  const branch = String(fd.get("branch_id") ?? "");
  const p = {
    id: String(fd.get("id") ?? "") || null,
    branch_id: /^[0-9a-f-]{36}$/i.test(branch) ? branch : null,
    category_id: String(fd.get("category_id") ?? ""),
    spent_on: String(fd.get("spent_on") ?? ""),
    amount_cents: amount,
    description: String(fd.get("description") ?? "").trim().slice(0, 120),
    payee: String(fd.get("payee") ?? "").trim().slice(0, 80) || null,
    paid_via: String(fd.get("paid_via") ?? "") || null,
    receipts: Array.isArray(receipts) ? receipts.filter((r) => typeof r === "string").slice(0, 5) : [],
  };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("save_expense", { p });
  if (error || !data?.ok) fail(fd, error, data?.error);
  revalidatePath("/business/expenses");
  redirect(back(fd, { ok: p.id ? "Expense updated." : `Added ${p.description}.` }));
}

export async function voidExpense(fd: FormData) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("void_expense", { p_id: String(fd.get("id") ?? ""), p_reason: String(fd.get("reason") ?? "").trim().slice(0, 200) });
  if (error || !data?.ok) fail(fd, error, data?.error);
  revalidatePath("/business/expenses");
  redirect(back(fd, { ok: "Expense removed." }));
}

/** Owners and the GM: add a category, or rename / set a monthly budget / hide one. */
export async function saveCategory(fd: FormData) {
  const budget = String(fd.get("budget") ?? "").trim();
  const p: Record<string, unknown> = { id: String(fd.get("id") ?? "") || null, name: String(fd.get("name") ?? "").trim().slice(0, 60) };
  if (fd.has("grp")) p.grp = String(fd.get("grp"));
  if (fd.has("kind")) p.kind = String(fd.get("kind"));
  if (fd.has("budget")) p.budget_cents = budget === "" ? null : pesos(budget);
  if (fd.has("active")) p.active = String(fd.get("active")) === "true";
  if (fd.has("budget") && budget !== "" && p.budget_cents === null) fail(fd, null, "BAD_AMOUNT");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("save_expense_category", { p });
  if (error || !data?.ok) fail(fd, error, data?.error);
  revalidatePath("/business/expenses");
  redirect(back(fd, { ok: "Category saved.", cats: "1" }));
}
