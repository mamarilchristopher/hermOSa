import { redirect } from "next/navigation";
import { requireAccess, branchesFor } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { manilaToday } from "@/lib/dates";
import type { NteList } from "@/lib/nte";
import { buildBoard, monthDays, type Person, type ShiftDay } from "@/lib/tardiness";
import { TardinessView, shiftMonth } from "./View";

type Q = { range: (a: number, b: number) => PromiseLike<{ data: unknown[] | null }> };
/** Supabase returns at most 1,000 rows a call: page through. */
async function all<T>(q: () => Q): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < 20000; from += 1000) {
    const { data } = await q().range(from, from + 999);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

/** CHRIS Nov 28 (option A): Tardiness dashboard. KPIs, then one row per person, worst first; tap a row for their Late NTEs. */
export default async function TardinessDashboard({ searchParams }: { searchParams: Promise<{ month?: string; branch?: string }> }) {
  const { supabase, access, branches } = await requireAccess();
  const manager = access.grants.some((g) => g.role === "OWNER" || g.role === "MANAGER");
  if (!manager) redirect("/nte");
  const today = manilaToday();
  const thisMonth = today.slice(0, 7);
  const sp = await searchParams;
  const ym = /^\d{4}-\d{2}$/.test(sp.month ?? "") && sp.month! <= thisMonth ? sp.month! : thisMonth;
  const pm = shiftMonth(ym, -1);
  const viewable = branchesFor(access, branches, ["OWNER", "MANAGER"]);
  const branch = viewable.find((b) => b.code === sp.branch) ?? null;
  const ids = new Set((branch ? [branch] : viewable).map((b) => b.id));
  const bName = Object.fromEntries(branches.map((b) => [b.id, b.name]));

  // Same day number last month, so a half month compares with a half month.
  const upTo = ym === thisMonth ? today : monthDays(ym).at(-1)!;
  const pDays = monthDays(pm);
  const pUpTo = ym === thisMonth ? pDays[Math.min(Number(today.slice(8)), pDays.length) - 1] : pDays.at(-1)!;
  const from = `${pm}-01`, to = monthDays(ym).at(-1)!;

  await supabase.rpc("run_nte_deadlines"); // automatic IRs that are due (update-0032)
  const [cur, prev, { data: me }, emps, shifts, ins] = await Promise.all([
    supabase.rpc("late_nte_list", { p_month: `${ym}-01`, p_employee: null }),
    supabase.rpc("late_nte_list", { p_month: `${pm}-01`, p_employee: null }),
    supabase.from("employees").select("id").eq("app_user_id", access.user_id).eq("active", true).order("created_at").limit(1).maybeSingle(),
    all<{ id: string; full_name: string; uid: string | null; branch_id: string | null; position: string | null; active: boolean }>(
      () => supabase.from("employees").select("id, full_name, uid, branch_id, position, active").order("full_name") as unknown as Q),
    all<ShiftDay>(() => supabase.from("shifts").select("employee_id, work_date").eq("state", "PUBLISHED").eq("is_off", false)
      .gte("work_date", from).lte("work_date", to).order("work_date") as unknown as Q),
    all<ShiftDay>(() => supabase.from("time_punches").select("employee_id, work_date").eq("kind", "IN")
      .gte("work_date", from).lte("work_date", to).order("work_date") as unknown as Q),
  ]);
  if (cur.error) {
    return (<><TopBar access={access} /><main><h1>Tardiness</h1><div className="notice info">Could not load. Try again.</div></main></>);
  }
  const list = cur.data as NteList;
  const limit = list.ir_minutes ?? 60;
  const people: Person[] = emps
    .filter((e) => e.id !== me?.id && e.branch_id && ids.has(e.branch_id))
    .map((e) => ({ id: e.id, name: e.full_name, uid: e.uid, branch: e.branch_id ? bName[e.branch_id] ?? null : null, position: e.position }));
  const board = buildBoard({ ym, upTo, people, shifts, ins, ntes: list.ntes, limit });
  const before = buildBoard({ ym: pm, upTo: pUpTo, people, shifts, ins, ntes: ((prev.data as NteList | null)?.ntes ?? []).filter((n) => n.work_date <= pUpTo), limit }).kpis;
  return (
    <>
      <TopBar access={access} />
      <TardinessView ym={ym} thisMonth={thisMonth} pm={pm} pUpTo={pUpTo} viewable={viewable} branch={branch} board={board} before={before} />
    </>
  );
}
