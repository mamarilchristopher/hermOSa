import Link from "next/link";
import { requireAccess, can, errorText } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { isIsoDate, manilaToday } from "@/lib/dates";
import { computeInsights, dateRuns, resolvePeriod, sortBranches, WEEKDAYS, weekday, type BranchInfo, type DayRow, type ZeroMark } from "@/lib/insights";
import { DecideForm, FillForm } from "./FillForm";
import { bulkConfirm, bulkMark } from "./actions";

type Daily =
  | { ok: true; branches: BranchInfo[]; days: DayRow[]; closed: ZeroMark[] }
  | { ok: false; error: string };

const MAX_LISTED = 200;

export default async function MissingDays({ searchParams }: { searchParams: Promise<{ p?: string; start?: string; end?: string; branch?: string; msg?: string }> }) {
  const { supabase, access } = await requireAccess();
  const sp = await searchParams;
  const today = manilaToday();
  const period = resolvePeriod(sp.p, isIsoDate(sp.start) ? sp.start : undefined, isIsoDate(sp.end) ? sp.end : undefined, today);
  const { data } = await supabase.rpc("historical_sales_daily", { p_start: period.start, p_end: period.end });
  const daily = (data ?? { ok: false, error: "UNKNOWN" }) as Daily;
  if (daily.ok) daily.branches = sortBranches(daily.branches);
  const back = `/?p=${period.key}&start=${period.start}&end=${period.end}`;

  const here = `/sales/missing?p=${period.key}&start=${period.start}&end=${period.end}${sp.branch ? `&branch=${sp.branch}` : ""}`;
  const msg = /^(marked|confirmed)-(\d+)-(\d+)$/.exec(sp.msg ?? "");
  let canMark = false;
  const confirmable: string[] = [];
  let body;
  if (!daily.ok) body = <div className="notice error">{errorText(daily.error)}</div>;
  else {
    const branches = daily.branches.filter((b) => !sp.branch || b.code === sp.branch);
    const ins = computeInsights({ period, today, branches, days: daily.days, closed: daily.closed });
    body = ins.branches.map((b) => {
      const editable = can(access, ["OWNER", "FINANCE", "MANAGER"], b.branch.id);
      const approver = can(access, ["OWNER", "FINANCE"], b.branch.id);
      const marks = new Map(daily.closed.filter((m) => m[0] === b.branch.id && m[3] === "PENDING").map((m) => [m[1], m]));
      if (editable) canMark = true;
      if (approver) for (const m of marks.values()) if (!m[6]) confirmable.push(m[4]);
      const runs = dateRuns(b.missing);
      const listed = [...b.missing].sort().reverse().slice(0, MAX_LISTED);
      return (
        <div className="card" key={b.branch.id}>
          <h2 style={{ marginTop: 0 }}>{b.branch.name}</h2>
          {!b.branch.first_date ? (
            <p className="muted small">No sales recorded for this branch yet.</p>
          ) : b.missing.length === 0 ? (
            <p className="small" style={{ color: "var(--good)" }}>✓ Every day in this period has sales or is marked closed.</p>
          ) : (
            <>
              <p className="small">
                <strong>{b.missing.length}</strong> day{b.missing.length > 1 ? "s" : ""} with no recorded sales
                {b.closedDays ? `, ${b.closedDays} confirmed closed or no sales` : ""}
                {b.pendingMarks ? `, ${b.pendingMarks} waiting for a second person` : ""}. Counted from {b.branch.first_date > period.start ? `the branch's first recorded day (${b.branch.first_date})` : period.start} to {ins.compareEnd}.
              </p>
              {runs.some((r) => r.days > 1) && (
                <p className="small muted">
                  Longer gaps: {runs.filter((r) => r.days > 1).sort((a, z) => z.days - a.days).slice(0, 5).map((r) => `${r.from} to ${r.to} (${r.days} days)`).join(" · ")}
                </p>
              )}
              <div className="table-wrap">
                <table>
                  <thead><tr>{editable && <th style={{ width: 36 }}><span className="sr-only">Select</span></th>}<th>Date</th><th>Day</th>{(editable || marks.size > 0) && <th>Fill in</th>}</tr></thead>
                  <tbody>
                    {listed.map((d) => {
                      const m = marks.get(d);
                      return (
                        <tr key={d}>
                          {editable && (
                            <td>{!m && <input type="checkbox" className="tick" name="days" value={`${b.branch.id}|${d}`} form="bulk-mark" aria-label={`Select ${d}`} />}</td>
                          )}
                          <td>{d}</td>
                          <td>{WEEKDAYS[weekday(d)]}</td>
                          {m ? (
                            <td><DecideForm mark={m[4]} label={m[2] === "CLOSED" ? "Closed" : "No sales"} by={m[6] ? "you" : m[5]} canDecide={approver && !m[6]} /></td>
                          ) : (
                            editable && <td><FillForm branch={b.branch.id} date={d} /></td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {b.missing.length > MAX_LISTED && <p className="small muted">Showing the latest {MAX_LISTED}. Pick a shorter period to see older days.</p>}
            </>
          )}
        </div>
      );
    });
  }

  return (
    <>
      <TopBar access={access} />
      <main>
        <p className="small"><Link href={back}>← Back to sales</Link></p>
        <h1>Days with no recorded sales</h1>
        <p className="muted small">
          {period.label} · {sp.branch ? <Link href={`/sales/missing?p=${period.key}&start=${period.start}&end=${period.end}`}>show all branches</Link> : "all branches"}.
          Enter the day&apos;s sales if you have them, or mark the day Closed or No sales. Nothing is guessed.
          Closed and No sales need a second person (Owner or Finance) to confirm before the day stops counting as missing.
          Sales entered by managers wait for an owner&apos;s sign-off on the Imports page.
        </p>
        {msg && (
          <div className="notice ok">
            {msg[1] === "marked" ? `${msg[2]} day${msg[2] === "1" ? "" : "s"} marked. A second person (Owner or Finance) now has to confirm them.` : `${msg[2]} day${msg[2] === "1" ? "" : "s"} confirmed.`}
            {msg[3] !== "0" && ` ${msg[3]} could not be saved (already recorded, or not allowed).`}
          </div>
        )}
        {confirmable.length > 0 && (
          <form action={bulkConfirm} className="card bulk-bar">
            <input type="hidden" name="back" value={here} />
            {confirmable.map((id) => <input key={id} type="hidden" name="marks" value={id} />)}
            <span><strong>{confirmable.length}</strong> Closed / No sales day{confirmable.length > 1 ? "s" : ""} marked by someone else {confirmable.length > 1 ? "are" : "is"} waiting for you.</span>
            <button type="submit">Confirm all {confirmable.length}</button>
          </form>
        )}
        {canMark && (
          <form id="bulk-mark" action={bulkMark} className="card bulk-bar">
            <input type="hidden" name="back" value={here} />
            <span>Tick the days below, then mark them all at once:</span>
            <span className="fill-row">
              <button type="submit" name="kind" value="NO_SALES" className="secondary">Mark ticked as No sales</button>
              <button type="submit" name="kind" value="CLOSED" className="secondary">Mark ticked as Closed</button>
            </span>
          </form>
        )}
        {body}
      </main>
    </>
  );
}
