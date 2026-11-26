import Link from "next/link";
import { requireAccess } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { manilaToday } from "@/lib/dates";
import { monthLabel } from "@/lib/insights";
import { dayLabel } from "@/lib/homeGlance";
import { timeLabel } from "@/lib/schedule";
import { firstName, times, tracker, type NteList } from "@/lib/nte";
import { NteDeadline, NteExplainForm, NteProofs } from "./Forms";
import { photoUrls } from "@/lib/photos";
import { Uid } from "@/components/Uid";

const shiftMonth = (ym: string, n: number) => {
  const d = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1 + n, 1));
  return d.toISOString().slice(0, 7);
};

/** Late NTEs. Management: the tardiness tracker for a month. Staff: their own NTEs with the explanation box. */
export default async function NtePage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const { supabase, access } = await requireAccess();
  const thisMonth = manilaToday().slice(0, 7);
  const sp = await searchParams;
  const ym = /^\d{4}-\d{2}$/.test(sp.month ?? "") && sp.month! <= thisMonth ? sp.month! : thisMonth;
  await supabase.rpc("run_nte_deadlines"); // automatic IRs that are due (update-0032)
  const { data, error } = await supabase.rpc("late_nte_list", { p_month: `${ym}-01`, p_employee: null });
  if (error) {
    return (<><TopBar access={access} /><main><h1>Late NTEs</h1>
      <div className="notice info">{error.code === "PGRST202" ? "The owner needs to run update-0030 in Supabase first." : "Could not load. Try again."}</div></main></>);
  }
  const list = data as NteList;
  const mine = list.ntes.filter((n) => n.mine);
  const proofs = await photoUrls(supabase, mine.flatMap((n) => n.proof_paths ?? []), "nte-proofs");
  const rows = tracker(list.ntes, list.ir_minutes);
  const manager = access.grants.some((g) => g.role === "OWNER" || g.role === "MANAGER");

  return (
    <>
      <TopBar access={access} />
      <main>
        <h1>Late NTEs</h1>
        <p className="muted small">A Late NTE (Notice to Explain) is made automatically when someone times in more than {list.grace} minutes after their shift starts.
          {manager ? ` An IR is suggested at 3 Late NTEs in a month, or sooner once someone is more than ${list.ir_minutes ?? 60} minutes late in total. Open a person to see their NTEs and issue an IR.` : " Write your explanation for each one."}</p>

        <div className="week-nav">
          <Link className="button secondary small" href={`/nte?month=${shiftMonth(ym, -1)}`}>← {monthLabel(shiftMonth(ym, -1))}</Link>
          <div className="week-title"><strong>{monthLabel(ym)}</strong></div>
          {ym < thisMonth ? <Link className="button secondary small" href={`/nte?month=${shiftMonth(ym, 1)}`}>{monthLabel(shiftMonth(ym, 1))} →</Link> : <span />}
        </div>

        {manager && (
          <div className="card">
            <h2>Tardiness tracker, {monthLabel(ym)}</h2>
            {rows.length === 0 ? <p className="muted" style={{ margin: 0 }}>No Late NTEs this month.</p> : (
              <ul className="plain-list">
                {rows.map((r) => (
                  <li key={r.employee_id} className={r.due ? "ir-due" : undefined}>
                    <span><strong>{r.name}</strong><Uid v={r.uid} /> has been issued Late NTEs <strong>{times(r.count)}</strong> this month
                      <br /><span className="small muted">{r.minutes} minutes late in total{r.open ? ` · ${r.open} not explained yet` : ""}{r.toReview ? ` · ${r.toReview} reason${r.toReview === 1 ? "" : "s"} to accept or reject` : ""}{r.notInIr && r.notInIr < r.count ? ` · ${r.count - r.notInIr} already in an IR` : r.notInIr === 0 ? " · all in an IR" : ""}</span>
                      {r.due && <><br /><span className="small ir-due-tag">IR suggested: {r.due}</span></>}</span>
                    <Link className="button secondary small" href={`/nte/staff/${r.employee_id}?month=${ym}`}>Open</Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {(mine.length > 0 || !manager) && (
          <div className="card">
            <h2>My Late NTEs, {monthLabel(ym)}</h2>
            {mine.length === 0 ? <p className="muted" style={{ margin: 0 }}>None this month.</p> : (
              <ul className="plain-list nte-list">
                {mine.map((n) => (
                  <li key={n.id} className={n.state === "OPEN" ? "urgent" : ""}>
                    <div className="nte-body">
                      <span><strong>NTE no. {n.nte_no} · {dayLabel(n.work_date)}</strong>
                        <br /><span className="small muted">Shift starts {timeLabel(n.shift_start)}, timed in {timeLabel(n.time_in)} ({n.late_minutes} minutes late){n.branch ? ` · ${n.branch}` : ""}</span></span>
                      {n.state === "OPEN" && <><NteDeadline n={n} /><NteExplainForm id={n.id} prompt={`Why were you late, ${firstName(n.name)}?`} /></>}
                      {(n.state === "EXPLAINED" || n.state === "ACCEPTED") && <p className="small" style={{ margin: 0 }}>Your explanation: {n.explanation}</p>}
                      {n.state === "ACCEPTED" && <p className="small" style={{ margin: 0, color: "var(--good)" }}><strong>Reason accepted</strong> · it doesn&apos;t count toward an IR{n.review_note ? ` · ${n.review_note}` : ""}</p>}
                      {n.review === "REJECTED" && <p className="small" style={{ margin: 0, color: "var(--bad)" }}><strong>Reason not accepted</strong> · it counts toward an IR{n.review_note ? ` · ${n.review_note}` : ""}</p>}
                      {n.state === "EXPLAINED" && !n.review && <p className="small muted" style={{ margin: 0 }}>Waiting for management to review your reason.</p>}
                      {(n.state === "EXPLAINED" || n.state === "ACCEPTED") && <NteProofs urls={(n.proof_paths ?? []).map((p) => proofs.get(p)).filter((u): u is string => !!u)} />}
                      {n.state === "VOID" && <p className="small muted" style={{ margin: 0 }}>Cancelled by management: {n.void_reason}</p>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </main>
    </>
  );
}
