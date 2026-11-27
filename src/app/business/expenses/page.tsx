import { redirect } from "next/navigation";
import { requireAccess, can } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { manilaToday } from "@/lib/dates";
import { photoUrls } from "@/lib/photos";
import { withApprovedSales } from "@/lib/approvedSales";
import { cellOf, type StatusDay } from "@/lib/homeGlance";
import { buildDashboard, lastDay, shiftMonth, type AdsAuto, type Category, type Expense, type PayrollAuto, type Scope } from "@/lib/expenses";
import { every } from "@/app/business/load";
import { ExpensesView } from "./View";
import type { Prefill } from "./Forms";

type DailyStatus = { ok: boolean; days?: StatusDay[] };

/** Business › Expenses (update-0100, CHRIS Nov 28). Owners, the GM and Finance; Auditors read only. */
export default async function ExpensesPage({ searchParams }: { searchParams: Promise<{ month?: string; branch?: string; cat?: string; cats?: string; ok?: string; err?: string }> }) {
  const { supabase, access, branches } = await requireAccess();
  const management = access.grants.some((g) => g.branch_id === null && (g.role === "OWNER" || g.role === "MANAGER"));
  const finance = can(access, ["FINANCE"], null), auditor = can(access, ["AUDITOR"], null);
  if (!management && !finance && !auditor) redirect("/");
  const today = manilaToday();
  const thisMonth = today.slice(0, 7);
  const sp = await searchParams;
  const ym = /^\d{4}-\d{2}$/.test(sp.month ?? "") && sp.month! <= thisMonth ? sp.month! : thisMonth;
  const pm = shiftMonth(ym, -1);
  const clinics = branches.filter((b) => b.kind === "CLINIC");
  const picked = clinics.find((b) => b.code === sp.branch);
  const scopeKey = sp.branch === "company" ? "company" : picked ? picked.code : "";
  const scope: Scope = sp.branch === "company" ? "company" : picked ? picked.id : null;
  const from = `${pm}-01`, to = `${ym}-${String(lastDay(ym)).padStart(2, "0")}`;

  const [{ data: catData, error: catErr }, expenses, { data: auto }, { data: st }] = await Promise.all([
    supabase.from("expense_categories").select("id, organization_id, name, grp, kind, auto_source, budget_cents, sort, active").order("sort").order("name"),
    every<Expense>((a, b) => supabase.from("expenses").select("id, branch_id, category_id, spent_on, amount_cents, description, payee, paid_via, receipt_paths")
      .is("voided_at", null).gte("spent_on", from).lte("spent_on", to).order("spent_on", { ascending: false }).range(a, b)),
    supabase.rpc("expense_auto", { p_from: from, p_to: to }),
    supabase.rpc("daily_sales_status", { p_start: from, p_end: ym === thisMonth ? today : to }),
  ]);
  if (catErr) {
    return (<><TopBar access={access} /><main><h1>Expenses</h1>
      <div className="notice info">{catErr.code === "42P01" || catErr.code === "PGRST205" ? "The owner needs to run update-0100 in Supabase first." : "Could not load. Try again."}</div></main></>);
  }
  const cats = (catData ?? []) as (Category & { organization_id: string })[];
  const s = (st ?? { ok: false }) as DailyStatus;
  const days = s.ok ? await withApprovedSales(supabase, s.days ?? [], ym === thisMonth ? today : to) : [];
  const sales = new Map<string, number>(), prevSales = new Map<string, number>();
  const pCut = `${pm}-${String(Math.min(Number(today.slice(8)), lastDay(pm))).padStart(2, "0")}`;
  for (const r of days) {
    const c = cellOf(r);
    if (c.kind !== "sales") continue;
    if (r[1].startsWith(ym)) sales.set(r[0], (sales.get(r[0]) ?? 0) + c.cents);
    else if (r[1].startsWith(pm) && (ym !== thisMonth || r[1] <= pCut)) prevSales.set(r[0], (prevSales.get(r[0]) ?? 0) + c.cents);
  }
  const a = (auto ?? {}) as { ok?: boolean; payroll?: PayrollAuto[]; ads?: AdsAuto[] };
  const d = buildDashboard({ ym, today, scope, branches: clinics, cats, expenses, payroll: a.payroll ?? [], ads: a.ads ?? [], sales, prevSales });

  const mine = expenses.filter((e) => e.spent_on.startsWith(ym));
  const urls = await photoUrls(supabase, mine.flatMap((e) => e.receipt_paths), "expense-receipts");
  const receipts = Object.fromEntries(mine.map((e) => [e.id, e.receipt_paths.map((path) => ({ path, url: urls.get(path) }))]));
  const prefills: Record<string, Prefill> = Object.fromEntries(mine.map((e) => [e.id, {
    id: e.id, branch_id: e.branch_id, category_id: e.category_id, spent_on: e.spent_on, amount: (e.amount_cents / 100).toFixed(2).replace(/\.00$/, ""),
    description: e.description, payee: e.payee, paid_via: e.paid_via, receipts: receipts[e.id],
  }]));
  const tabs = [{ key: "", label: "All branches" }, ...clinics.map((b) => ({ key: b.code, label: b.name })), { key: "company", label: "Company-wide" }];
  const catFilter = sp.cat && (cats.some((c) => c.id === sp.cat) || sp.cat === "share") ? sp.cat : null;

  return (
    <>
      <TopBar access={access} />
      <ExpensesView ym={ym} thisMonth={thisMonth} today={today} scope={scopeKey} scopeLabel={tabs.find((t) => t.key === scopeKey)?.label ?? ""}
        org={cats[0]?.organization_id ?? ""} branches={clinics.map((b) => ({ id: b.id, name: b.name, code: b.code }))} tabs={tabs} cats={cats} d={d}
        canManage={management || finance} canCategories={management} receipts={receipts} prefills={prefills} catFilter={catFilter}
        showCats={sp.cats === "1"} ok={sp.ok?.slice(0, 200)} err={sp.err?.slice(0, 200)} />
    </>
  );
}
