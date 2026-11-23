import Link from "next/link";
import { requireAccess, errorText } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { SalesView } from "@/components/SalesView";
import { isIsoDate, manilaToday } from "@/lib/dates";
import { computeInsights, fetchStart, resolvePeriod, type BranchInfo, type DayRow } from "@/lib/insights";

type Daily =
  | { ok: true; consolidated: boolean; branches: BranchInfo[]; days: DayRow[]; closed: [string, string][] }
  | { ok: false; error: string };

const PRESETS = [
  ["month", "This month"],
  ["lastmonth", "Last month"],
  ["ytd", "Year to date"],
  ["12m", "Last 12 months"],
] as const;

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ p?: string; start?: string; end?: string }> }) {
  const { supabase, access } = await requireAccess();
  const sp = await searchParams;
  const today = manilaToday();
  const period = resolvePeriod(sp.p, isIsoDate(sp.start) ? sp.start : undefined, isIsoDate(sp.end) ? sp.end : undefined, today);
  const { data } = await supabase.rpc("historical_sales_daily", { p_start: fetchStart(period), p_end: period.end });
  const daily = (data ?? { ok: false, error: "UNKNOWN" }) as Daily;
  const { count: pending } = await supabase.from("import_batches").select("id", { count: "exact", head: true }).eq("state", "STAGED");

  const q = `p=${period.key}&start=${period.start}&end=${period.end}`;
  const header = (
    <>
      <div className="periods card">
        {PRESETS.map(([k, label]) => (
          <Link key={k} href={`/?p=${k}`} className={period.key === k ? "on" : ""}>{label}</Link>
        ))}
        <form>
          <input type="hidden" name="p" value="custom" />
          <input type="date" name="start" defaultValue={period.start} aria-label="From" />
          <span className="muted">to</span>
          <input type="date" name="end" defaultValue={period.end} max={today} aria-label="To" />
          <button type="submit" className="secondary">Show</button>
        </form>
      </div>
    </>
  );

  if (!daily.ok) {
    return (
      <>
        <TopBar access={access} />
        <main><h1>Sales</h1>{header}<div className="notice error">{errorText(daily.error)}</div></main>
      </>
    );
  }
  if (daily.branches.length === 0) {
    return (
      <>
        <TopBar access={access} />
        <main><h1>Sales</h1><div className="notice info">You don't have sales access to any branch yet.</div></main>
      </>
    );
  }

  const ins = computeInsights({ period, today, branches: daily.branches, days: daily.days, closed: daily.closed });
  const anyData = daily.branches.some((b) => b.first_date);
  const whole = daily.consolidated || daily.branches.length > 1;
  const throughText = ins.compareEnd < period.start ? "no complete days yet" : `${period.start} to ${ins.compareEnd}`;

  return (
    <>
      <TopBar access={access} />
      <main>
        <h1>{whole ? "Sales: all branches" : `Sales: ${daily.branches[0].name}`}</h1>
        <p className="muted small">
          {period.label} · {throughText} (Manila, today not counted until it's recorded) · published imports only
        </p>
        {header}
        {(pending ?? 0) > 0 && (
          <div className="notice info">
            {pending} upload{pending! > 1 ? "s are" : " is"} waiting for sign-off and not counted. <Link href="/imports">Review</Link>
          </div>
        )}
        {!anyData && <div className="notice info">No validated data yet. Sales show here once an import is published.</div>}

        {anyData && <SalesView ins={ins} whole={whole} q={q} />}
      </main>
    </>
  );
}
