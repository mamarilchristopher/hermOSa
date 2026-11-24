import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAccess } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { centsToPhp } from "@/lib/csv";
import { manilaToday } from "@/lib/dates";
import { addDays, addMonths, monthEnd, monthLabel, sortBranches } from "@/lib/insights";
import { DecideForm } from "./Forms";
import { MonthGrid, type GridCell } from "./MonthGrid";

type Status = {
  ok: boolean; error?: string; second_signoff: boolean;
  branches: { id: string; code: string; name: string; can_enter: boolean; self_publish: boolean; can_approve: boolean }[];
  days: [string, string, number | null, string | null, boolean, number | null][];
  corrections: { id: string; branch_id: string; date: string; old_cents: number; new_cents: number; reason: string; requested_by: string; mine: boolean }[];
};

/** Daily sales tracker: the month as a sheet (a row per day, a column per branch), typed in place. */
export default async function DailySales({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const { supabase, access } = await requireAccess();
  if (!access.grants.some((g) => ["OWNER", "FINANCE", "MANAGER", "AUDITOR"].includes(g.role))) redirect("/me");
  const today = manilaToday();
  const sp = await searchParams;
  const thisMonth = today.slice(0, 7);
  const ym = /^\d{4}-\d{2}$/.test(sp.month ?? "") && sp.month! <= thisMonth ? sp.month! : thisMonth;
  const start = `${ym}-01`;
  const end = ym === thisMonth ? today : monthEnd(start);
  const [{ data }, { data: changedData }, { data: twoData }] = await Promise.all([
    supabase.rpc("daily_sales_status", { p_start: start, p_end: end }),
    supabase.rpc("changed_sales_days", { p_start: start, p_end: end }),
    supabase.from("sales_corrections").select("id").eq("state", "PENDING").eq("needs_two", true),
  ]);
  // Before update-0015 these two come back as errors; the page still works without them.
  const changed = (Array.isArray(changedData) ? changedData as [string, string][] : []).map(([b, d]) => `${b}|${d}`);
  const needsTwo = new Set((twoData ?? []).map((x: { id: string }) => x.id));
  const gm = access.grants.some((g) => g.role === "MANAGER" && g.branch_id === null);
  const st = (data ?? { ok: false }) as Status;
  const branches = st.ok ? sortBranches(st.branches) : [];
  const dates: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) dates.push(d);
  const cells: Record<string, GridCell> = {};
  for (const [b, d, rec, mark, staged, service] of st.days ?? []) {
    cells[`${b}|${d}`] = [rec === null ? null : Number(rec), mark, staged, service === null ? null : Number(service), false];
  }
  for (const c of st.corrections ?? []) {
    const k = `${c.branch_id}|${c.date}`;
    if (cells[k]) cells[k][4] = true;
  }
  const prev = addMonths(start, -1).slice(0, 7), next = addMonths(start, 1).slice(0, 7);
  const anyEnter = branches.some((b) => b.can_enter);
  const gaps = dates.filter((d) => d < today).reduce((n, d) => n + branches.filter((b) => {
    const c = cells[`${b.id}|${d}`];
    return !c || (c[0] === null && !c[1] && !c[2]);
  }).length, 0);

  return (
    <>
      <TopBar access={access} />
      <main className="wide">
        <h1>Daily sales</h1>
        <p className="muted small">Type each branch&apos;s total for the day, like the Sales Source Tracker. Press Save (or Enter) to keep them. Amounts are declared sales (cash and online).</p>

        <div className="periods card">
          <div className="segmented">
            <Link href={`/sales/daily?month=${prev}`}>← {monthLabel(prev)}</Link>
            <Link href={`/sales/daily?month=${ym}`} className="on">{monthLabel(ym)}</Link>
            {ym < thisMonth && <Link href={`/sales/daily?month=${next}`}>{monthLabel(next)} →</Link>}
          </div>
          {anyEnter && <span><Link className="button secondary small" href="/sales/upload">Upload a tracker file instead</Link></span>}
        </div>

        {!st.ok && <div className="notice error">Daily sales isn&apos;t set up yet. The owner needs to run update-0013 in Supabase.</div>}
        {st.ok && (
          <>
            {gaps > 0 && <p className="small">{gaps} branch-day{gaps === 1 ? "" : "s"} this month with nothing entered (highlighted). Use the ▾ in a cell to mark it Zero sales or Closed.</p>}
            <MonthGrid dates={dates} branches={branches.map((b) => ({ id: b.id, name: b.name, can_enter: b.can_enter }))} cells={cells} today={today} changed={changed} />
            <p className="small muted">▾ in an empty cell: Zero sales, Closed or Enter sales (typing 0 also means zero sales). • the total differs from that day&apos;s service log (hover to see it). ✎ a change is waiting for sign-off. ↺ changed before: another change needs a second person to confirm. Every change notifies the other management members.
              {st.second_signoff ? " Entries wait for a second person on Imports before they count." : " While second sign-off is off, entries by owners and the general manager count right away."}</p>

            {st.corrections.length > 0 && (
              <div className="card">
                <h2>Corrections waiting for sign-off</h2>
                <ul className="plain-list">
                  {st.corrections.map((x) => {
                    const b = branches.find((y) => y.id === x.branch_id);
                    return (
                      <li key={x.id}>
                        <span><strong>{b?.name}</strong>, {x.date}: {centsToPhp(x.old_cents)} → <strong>{centsToPhp(x.new_cents)}</strong>
                          <span className="small muted"> · {x.reason} · asked by {x.requested_by}</span></span>
                        {needsTwo.has(x.id) && <span className="tag">needs a second person</span>}
                        {(b?.can_approve || (gm && needsTwo.has(x.id))) && <DecideForm id={x.id} mine={x.mine} />}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </>
        )}
      </main>
    </>
  );
}
