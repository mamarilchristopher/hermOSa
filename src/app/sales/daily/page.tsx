import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAccess } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { centsToPhp } from "@/lib/csv";
import { manilaToday } from "@/lib/dates";
import { addDays, addMonths, monthEnd, monthLabel, sortBranches } from "@/lib/insights";
import { DecideForm } from "./Forms";
import { MonthGrid, type GridCell } from "./MonthGrid";
import { highlightKeys } from "@/lib/noticeLink";
import { withApprovedSales } from "@/lib/approvedSales";
import { SERVICE_LOG_FROM, type StatusDay } from "@/lib/homeGlance";

type Status = {
  ok: boolean; error?: string; second_signoff: boolean;
  branches: { id: string; code: string; name: string; can_enter: boolean; self_publish: boolean; can_approve: boolean }[];
  days: StatusDay[];
  corrections: { id: string; branch_id: string; date: string; old_cents: number; new_cents: number; reason: string; requested_by: string; mine: boolean }[];
};

/** Daily sales tracker: the month as a sheet (a row per day, a column per branch), typed in place. */
export default async function DailySales({ searchParams }: { searchParams: Promise<{ month?: string; hl?: string }> }) {
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
  // v0.99.3 (CHRIS Nov 28): from Nov 25 the service log figure is the APPROVED total, so late sign-offs fill the right day.
  for (const [b, d, rec, mark, staged, service, pend] of st.ok ? await withApprovedSales(supabase, st.days ?? [], end) : []) {
    cells[`${b}|${d}`] = [rec === null ? null : Number(rec), mark, staged, service === null ? null : Number(service), false, pend ? Number(pend) : null, d >= SERVICE_LOG_FROM];
  }
  for (const c of st.corrections ?? []) {
    const k = `${c.branch_id}|${c.date}`;
    if (cells[k]) cells[k][4] = true;
  }
  // v0.101.2: days where a typed figure differs from the approved entries (the entries are what counts).
  const names = Object.fromEntries(branches.map((b) => [b.id, b.name.replace(/ \(.*\)$/, "")]));
  const typedOff = Object.entries(cells).filter(([, c]) => c[6] && c[0] !== null && (c[3] ?? 0) > 0 && c[0] !== c[3])
    .map(([k, c]) => { const [b, d] = k.split("|"); return { k, b, d, typed: c[0]!, entries: c[3]! }; })
    .filter((x) => names[x.b]).sort((a, b) => a.d.localeCompare(b.d) || branches.findIndex((x) => x.id === a.b) - branches.findIndex((x) => x.id === b.b));
  const prev = addMonths(start, -1).slice(0, 7), next = addMonths(start, 1).slice(0, 7);
  const anyEnter = branches.some((b) => b.can_enter);
  const gaps = dates.filter((d) => d < today).reduce((n, d) => n + branches.filter((b) => {
    const c = cells[`${b.id}|${d}`];
    return !c || (c[0] === null && !c[1] && !c[2] && !(c[6] && (c[3] ?? 0) > 0));
  }).length, 0);

  return (
    <>
      <TopBar access={access} />
      <main className="wide">
        <h1>Daily sales</h1>
        <p className="muted small">From Nov 25 each day is the total of the branch&apos;s approved Service log entries, so every figure has entries behind it (sales signed off later still land on their service date). A typed total only counts on a day with no approved entries. Amounts are declared sales (cash and online).</p>

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
            {typedOff.length > 0 && (
              <div className="notice info typed-off">
                <strong>{typedOff.length} day{typedOff.length === 1 ? "" : "s"} where a typed figure differs from the approved entries.</strong> The entries&apos; total is used. Open the day&apos;s Service log to check for missing or wrongly dated entries.
                <ul className="plain-list small">
                  {typedOff.map((x) => (
                    <li key={x.k}><span><strong>{names[x.b]}</strong>, {new Date(`${x.d}T00:00:00Z`).toLocaleDateString("en-PH", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" })}: entries <strong>{centsToPhp(x.entries).replace(/\.00$/, "")}</strong>, typed {centsToPhp(x.typed).replace(/\.00$/, "")}</span>
                      <Link className="button secondary small" href={`/services?date=${x.d}&branch=${branches.find((b) => b.id === x.b)?.code ?? ""}`}>Open entries</Link></li>
                  ))}
                </ul>
              </div>
            )}
            {gaps > 0 && <p className="small">{gaps} branch-day{gaps === 1 ? "" : "s"} this month with nothing entered (highlighted). Use the ▾ in a cell to mark it Zero sales or Closed.</p>}
            <MonthGrid dates={dates} branches={branches.map((b) => ({ id: b.id, name: b.name, can_enter: b.can_enter }))} cells={cells} today={today} changed={changed} highlight={highlightKeys(sp.hl, branches, ym)} />
            <p className="small muted">▾ in an empty cell: Zero sales, Closed or Enter sales (typing 0 also means zero sales). Gold amounts come from approved Service log entries; +₱ = logged but still waiting for sign-off. • a typed total differs from that day&apos;s approved service log (hover to see it). ✎ a change is waiting for sign-off. ↺ changed before. Every save notifies the other management members, and changing a saved day needs a second person to confirm.
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
                        {(b?.can_approve || gm) && <DecideForm id={x.id} mine={x.mine} />}
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
