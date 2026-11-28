import { redirect } from "next/navigation";
import { requireAccess, can } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { manilaToday } from "@/lib/dates";
import { withApprovedSales } from "@/lib/approvedSales";
import { cellOf, type StatusDay } from "@/lib/homeGlance";
import type { AdsAuto, Category, Expense, PayrollAuto, Scope } from "@/lib/expenses";
import { buildReport, daysBetween, periodOf } from "@/lib/expenseReport";
import { every } from "@/app/business/load";
import { ReportView } from "./View";

type Sp = { period?: string; at?: string; from?: string; to?: string; branch?: string };
type Auto = { ok?: boolean; payroll?: PayrollAuto[]; ads?: AdsAuto[] };

/** Business › Expenses › Expense report (format A "One-page summary", CHRIS Nov 28 2026). Same people as Expenses. */
export default async function ExpenseReportPage({ searchParams }: { searchParams: Promise<Sp> }) {
  const { supabase, access, branches } = await requireAccess();
  const management = access.grants.some((g) => g.branch_id === null && (g.role === "OWNER" || g.role === "MANAGER"));
  if (!management && !can(access, ["FINANCE"], null) && !can(access, ["AUDITOR"], null)) redirect("/");
  const today = manilaToday();
  const sp = await searchParams;
  const per = periodOf(sp, today);
  const clinics = branches.filter((b) => b.kind === "CLINIC");
  const picked = clinics.find((b) => b.code === sp.branch);
  const scopeKey = sp.branch === "company" ? "company" : picked ? picked.code : "";
  const scope: Scope = sp.branch === "company" ? "company" : picked ? picked.id : null;
  const scopeLabel = scope === null ? "All branches + company-wide" : scope === "company" ? "Company-wide costs only" : `${picked!.name} (with its share of company-wide costs)`;

  // The period and the one before it; ad/payroll lookups allow 400 days a call, so a year is fetched in two.
  const from = per.prevFrom, to = per.upTo;
  const autoCall = (a: string, b: string) => supabase.rpc("expense_auto", { p_from: a, p_to: b });
  const split = daysBetween(from, to) > 400;
  const [{ data: catData, error: catErr }, expenses, { data: autoA }, { data: autoB }, { data: st }] = await Promise.all([
    supabase.from("expense_categories").select("id, name, grp, kind, auto_source, budget_cents, sort, active").order("sort").order("name"),
    every<Expense>((a, b) => supabase.from("expenses").select("id, branch_id, category_id, spent_on, amount_cents, description, payee, paid_via, receipt_paths")
      .is("voided_at", null).gte("spent_on", from).lte("spent_on", to).order("spent_on").range(a, b)),
    split ? autoCall(per.from, per.upTo) : autoCall(from, to),
    split ? autoCall(per.prevFrom, per.prevTo) : Promise.resolve({ data: null }),
    supabase.rpc("daily_sales_status", { p_start: from, p_end: to }),
  ]);
  if (catErr) {
    return (<><TopBar access={access} /><main><h1>Expense report</h1>
      <div className="notice info">{catErr.code === "42P01" || catErr.code === "PGRST205" ? "The owner needs to run update-0100 in Supabase first." : "Could not load. Try again."}</div></main></>);
  }
  const cats = (catData ?? []) as Category[];
  const a = (autoA ?? {}) as Auto, b = (autoB ?? null) as Auto | null;
  const s = (st ?? { ok: false }) as { ok: boolean; days?: StatusDay[] };
  const days = s.ok ? await withApprovedSales(supabase, s.days ?? [], to) : [];
  const sales = new Map<string, number>(), prevSales = new Map<string, number>();
  for (const r of days) {
    const c = cellOf(r);
    if (c.kind !== "sales") continue;
    if (r[1] >= per.from && r[1] <= per.upTo) sales.set(r[0], (sales.get(r[0]) ?? 0) + c.cents);
    else if (r[1] >= per.prevFrom && r[1] <= per.prevTo) prevSales.set(r[0], (prevSales.get(r[0]) ?? 0) + c.cents);
  }
  const rep = buildReport({
    period: per, scope, branches: clinics, cats, expenses, sales, prevSales,
    payroll: a.payroll ?? [], ads: a.ads ?? [], prevPayroll: b ? b.payroll ?? [] : undefined, prevAds: b ? b.ads ?? [] : undefined,
  });

  const tabs = [{ key: "", label: "All branches" }, ...clinics.map((x) => ({ key: x.code, label: x.name })), { key: "company", label: "Company-wide" }];
  return (
    <>
      <TopBar access={access} />
      <ReportView per={per} rep={rep} today={today} scopeKey={scopeKey} scopeLabel={scopeLabel} placeName={picked?.name ?? ""} by={access.display_name}
        stamp={new Date().toLocaleString("en-US", { timeZone: "Asia/Manila", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}
        tabs={tabs} />
    </>
  );
}
