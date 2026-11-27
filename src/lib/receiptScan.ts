// Expenses › Scan receipt (v0.100.1, CHRIS Nov 28): what the reader is told, and how its answer is cleaned up before it
// fills the Add expense form. Pure functions (no SDK) so they can be tested; the call itself is in app/api/expenses/scan.

export const DOC_TYPES = ["RECEIPT", "BILL", "PAYMENT_SCREENSHOT", "APP_SCREENSHOT", "VOUCHER", "EXPENSE_LIST", "SALES_INVOICE", "NOT_A_RECEIPT"] as const;
export type DocType = (typeof DOC_TYPES)[number];
export const PAID_VIA = ["CASH", "BANK", "GCASH", "CARD", "OTHER"] as const;
export type PaidVia = (typeof PAID_VIA)[number];

/** Each clinic's registered business name (CHRIS Nov 28) and area, so a name or address on a bill or receipt points to the right branch. */
export const BRANCH_AREAS: Record<string, string> = {
  QC_MAIN: "registered name HermosaUNO. Quezon City along Mindanao Avenue (Bahay Toro, Project 8, Tandang Sora area). Any Quezon City address that is NOT Fairview/Novaliches.",
  FAIRVIEW: "registered name HermosaDOS. Fairview, Quezon City (Fairview, Novaliches, Commonwealth north area).",
  STA_MARIA: "registered name HermosaTres. Santa Maria, Bulacan (also written Sta. Maria or SMB).",
  MARIKINA: "registered name HermosaCuatro. Marikina City (e.g. Parang, Concepcion).",
};

/** The reader's raw answer (the shape the JSON schema asks for). */
export type RawScan = {
  doc_type: DocType;
  payee: string | null;
  paid_via: PaidVia | null;
  branch_code: string | null;
  branch_reason: string | null;
  note: string;
  items: { date: string | null; amount: number; description: string; category_id: string | null; unsure: boolean }[];
};

export type ScanItem = { spent_on: string | null; amount_cents: number; description: string; category_id: string | null; unsure: boolean;
  dup?: { description: string; spent_on: string } };
export type Scan = {
  doc_type: DocType; not_expense: boolean; payee: string | null; paid_via: PaidVia | null;
  branch_id: string | null; branch_name: string | null; branch_reason: string | null; note: string; items: ScanItem[]; total_cents: number;
};

export type ScanCat = { id: string; name: string; grp: string };
export type ScanBranch = { id: string; code: string; name: string };

/** The instructions. Stable text first (the categories and branches change rarely), today's date last. */
export function scanSystem(cats: ScanCat[], branches: ScanBranch[]) {
  return [
    "You read photos and screenshots of business expenses for Hermosa Aesthetics, an aesthetic clinic with branches in the Philippines.",
    "Amounts are Philippine pesos. Return exactly what should be recorded as expenses, following these rules.",
    "",
    "What you will see, and how to record it:",
    "- Utility bills (electricity such as Meralco, water, internet, phone such as PLDT, Globe, Smart, DITO, Converge): one item, the total amount due (\"Please pay\", \"Total amount due\"). Description like \"Electricity bill, October 2026\" using the billing period month. Date: the payment date only if the image shows it was paid (a payment stamp or receipt); otherwise null.",
    "- Bill payment receipts and payment screenshots (GCash, GBills, Maya, bank app, bayad center): one item, the amount paid, the payment date. paid_via GCASH for GCash, BANK for bank transfers, CARD for card slips.",
    "- Store and POS receipts (grocery, hardware, pharmacy, restaurants): one item, the final total paid (VAT included, after discounts). Description: a short summary of the main things bought (e.g. \"Pantry groceries: coffee, sugar, cups\").",
    "- Delivery and ride apps (Lalamove, Grab, Move It, Angkas, Joyride, Transportify): one item per completed trip or order shown, each with its own date and amount. Skip cancelled ones.",
    "- Petty cash vouchers (often handwritten): the particulars are the description, the amount, the date; the person who received the cash is the payee. paid_via CASH.",
    "- Handwritten expense lists or ledgers: one item per written row, with its own date (a row with no date takes the date written above it). Skip rows that are totals, subtotals, running balances, cash on hand, cash advances given or returned, change, or crossed out.",
    "- Small handwritten receipts (water refill delivery, LPG, laundry, repairs): one item with the total.",
    "- A chat screenshot that shows receipt photos: read the receipts in it as above.",
    "",
    "Not expenses: a sales or service invoice or official receipt where Hermosa or one of the branch names below (HermosaUNO, HermosaDOS, HermosaTres, HermosaCuatro) is the SELLER (a client paying for a treatment or product). Use doc_type SALES_INVOICE and return no items.",
    "If no amount can be read at all, use doc_type NOT_A_RECEIPT and return no items.",
    "",
    "Dates: return YYYY-MM-DD. Philippine dates are usually month/day/year. A date written without a year is the most recent such date that is not after today. Never return a date after today.",
    "Amounts: numbers only (no peso sign or commas), up to 2 decimals. Never invent an amount; leave out a row you cannot read and say so in the note.",
    "Set unsure to true on any item whose amount or date was hard to read, guessed, or partly cut off.",
    "Payee: the business or person who was paid (the utility company, store name, app name, or the staff member who received petty cash). Never copy account numbers, card numbers, reference numbers or addresses into any field.",
    "paid_via: only when the image shows it (cash, GCash, bank, card); otherwise null.",
    "",
    "Category: pick the best category_id from this list for each item, or null if none fits:",
    ...cats.map((c) => `- ${c.id}: ${c.name}`),
    "Hints: drinking water deliveries and pantry groceries go to staff meals & pantry when that exists; Lalamove and rides go to transport & delivery; laundry to laundry & linens; aircon or plumbing repairs to repairs & maintenance; medical exams for staff (x-ray, health card) to HMO & insurance or miscellaneous.",
    "",
    "Branch: decide which branch the expense belongs to. Strongest sign: a branch's registered name (HermosaUNO, HermosaDOS, HermosaTres, HermosaCuatro, any spacing or capitals, e.g. \"Hermosa Cuatro\") as the customer, account name or \"sold to\". Next: the service address on a bill, then a \"sold to\" or delivery address, then the store's own location when it is clearly near one branch. Use branch_code null when nothing points to one branch. Branches:",
    ...branches.map((b) => `- ${b.code} (${b.name}): ${BRANCH_AREAS[b.code] ?? b.name}`),
    "branch_reason: a few words on what pointed to the branch (e.g. \"service address in Fairview\").",
    "",
    "note: one short plain-English sentence (under 140 characters) telling the person what to double-check, or \"\" if nothing.",
  ].join("\n");
}

export const scanUser = (today: string, fileName: string) =>
  `Today in Manila is ${today}. Read this ${/\.pdf$/i.test(fileName) ? "document" : "image"} and return the expenses to record.`;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s: string | null, today: string) => {
  if (!s || !DATE.test(s) || s > today || s < "2020-01-01") return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : s;
};
const clip = (s: string | null | undefined, n: number) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** Clean the reader's answer: real categories and branches only, amounts in centavos, no future dates, at most 40 rows. */
export function normalizeScan(raw: RawScan, o: { cats: ScanCat[]; branches: ScanBranch[]; today: string }): Scan {
  const catIds = new Set(o.cats.map((c) => c.id));
  const notExpense = raw.doc_type === "SALES_INVOICE";
  const items: ScanItem[] = notExpense ? [] : (raw.items ?? []).flatMap((it) => {
    const cents = Math.round(Number(it.amount) * 100);
    if (!Number.isFinite(cents) || cents < 1 || cents > 100000000000) return [];
    const cat = it.category_id && catIds.has(it.category_id) ? it.category_id : null;
    let desc = clip(it.description, 120);
    if (desc.length < 2) desc = cat ? o.cats.find((c) => c.id === cat)!.name : "Expense";
    const date = validDate(it.date, o.today);
    return [{ spent_on: date, amount_cents: cents, description: desc, category_id: cat, unsure: !!it.unsure || (it.date !== null && date === null) }];
  }).slice(0, 40);
  const branch = o.branches.find((b) => b.code === raw.branch_code) ?? null;
  return {
    doc_type: DOC_TYPES.includes(raw.doc_type) ? raw.doc_type : "RECEIPT",
    not_expense: notExpense,
    payee: clip(raw.payee, 80) || null,
    paid_via: raw.paid_via && PAID_VIA.includes(raw.paid_via) ? raw.paid_via : null,
    branch_id: branch?.id ?? null,
    branch_name: branch?.name ?? null,
    branch_reason: branch ? clip(raw.branch_reason, 80) || null : null,
    note: clip(raw.note, 160),
    items,
    total_cents: items.reduce((s, x) => s + x.amount_cents, 0),
  };
}

const dayDiff = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000;

/** Mark rows that look already entered: same amount within 3 days (or within 40 days when the receipt has no date). */
export function markDuplicates(items: ScanItem[], existing: { amount_cents: number; spent_on: string; description: string }[], today: string) {
  return items.map((it) => {
    const hit = existing.find((e) => e.amount_cents === it.amount_cents && dayDiff(e.spent_on, it.spent_on ?? today) <= (it.spent_on ? 3 : 40));
    return hit ? { ...it, dup: { description: hit.description, spent_on: hit.spent_on } } : it;
  });
}
