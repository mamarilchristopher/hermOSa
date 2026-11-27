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
  BAD_BRANCH: "Pick the branch this is for (or Company-wide).",
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

/** v0.100.1: every expense names its branch: a branch id, or "company" for Company-wide (stored as no branch). */
const branchOf = (fd: FormData): string | null | undefined => {
  const b = String(fd.get("branch_id") ?? "");
  return /^[0-9a-f-]{36}$/i.test(b) ? b : b === "company" ? null : undefined;
};
const receiptsOf = (fd: FormData) => {
  let r: unknown = [];
  try { r = JSON.parse(String(fd.get("receipts") ?? "[]")); } catch { r = []; }
  return Array.isArray(r) ? r.filter((x): x is string => typeof x === "string").slice(0, 5) : [];
};

/** Add or correct an expense. Receipts are uploaded by the browser first (expense-receipts/<org>/<id>.<ext>). */
export async function saveExpense(fd: FormData) {
  const amount = pesos(fd.get("amount"));
  if (amount === null || amount < 1) fail(fd, null, "BAD_AMOUNT");
  const branch = branchOf(fd);
  if (branch === undefined) fail(fd, null, "BAD_BRANCH");
  const p = {
    id: String(fd.get("id") ?? "") || null,
    branch_id: branch ?? null,
    category_id: String(fd.get("category_id") ?? ""),
    spent_on: String(fd.get("spent_on") ?? ""),
    amount_cents: amount,
    description: String(fd.get("description") ?? "").trim().slice(0, 120),
    payee: String(fd.get("payee") ?? "").trim().slice(0, 80) || null,
    paid_via: String(fd.get("paid_via") ?? "") || null,
    receipts: receiptsOf(fd),
  };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("save_expense", { p });
  if (error || !data?.ok) fail(fd, error, data?.error);
  revalidatePath("/business/expenses");
  redirect(back(fd, { ok: p.id ? "Expense updated." : `Added ${p.description}.` }));
}

/** v0.100.1 Scan receipt: several expenses read from one receipt (a handwritten list, a ride list), same branch and receipt. */
export async function saveExpenses(fd: FormData) {
  const branch = branchOf(fd);
  if (branch === undefined) fail(fd, null, "BAD_BRANCH");
  let rows: { spent_on?: unknown; amount?: unknown; description?: unknown; category_id?: unknown }[] = [];
  try { rows = JSON.parse(String(fd.get("rows") ?? "[]")); } catch { rows = []; }
  if (!Array.isArray(rows) || !rows.length || rows.length > 40) fail(fd, null, "BAD_REQUEST");
  const receipts = receiptsOf(fd), payee = String(fd.get("payee") ?? "").trim().slice(0, 80) || null, paid_via = String(fd.get("paid_via") ?? "") || null;
  const supabase = await createClient();
  let saved = 0, total = 0;
  const missed: string[] = [];
  for (const [i, r] of rows.entries()) {
    const amount = pesos(String(r.amount ?? ""));
    const description = String(r.description ?? "").trim().slice(0, 120);
    if (amount === null || amount < 1) { missed.push(`line ${i + 1} (${ERR.BAD_AMOUNT})`); continue; }
    const { data, error } = await supabase.rpc("save_expense", { p: {
      id: null, branch_id: branch ?? null, category_id: String(r.category_id ?? ""), spent_on: String(r.spent_on ?? ""), amount_cents: amount,
      description, payee, paid_via, receipts,
    } });
    if (error && (error.code === "PGRST202" || error.code === "42P01")) fail(fd, error);
    if (error || !data?.ok) { missed.push(`line ${i + 1}${description ? `, ${description.slice(0, 30)}` : ""} (${ERR[data?.error ?? ""] ?? "not saved"})`); continue; }
    saved++; total += amount;
  }
  revalidatePath("/business/expenses");
  const sum = `₱${(total / 100).toLocaleString("en-PH", { maximumFractionDigits: 2 })}`;
  if (missed.length) redirect(back(fd, { err: `Saved ${saved} of ${rows.length} (${sum}). Not saved: ${missed.slice(0, 4).join("; ")}${missed.length > 4 ? "; …" : ""}. Add those with + Add expense.` }));
  redirect(back(fd, { ok: `Added ${saved} expenses (${sum}).` }));
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
