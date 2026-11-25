import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { requireAccess } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { manilaToday } from "@/lib/dates";
import { monthLabel } from "@/lib/insights";
import { dayLabel } from "@/lib/homeGlance";
import { timeLabel } from "@/lib/schedule";
import { firstName, irReason, IR_MINUTES_DEFAULT, IR_NTE_COUNT, nteCount, type NteList } from "@/lib/nte";
import { IssueLateIrForm, NteDeadline, VoidNteForm } from "../../Forms";
import { Uid } from "@/components/Uid";

const STATE: Record<string, { label: string; cls: string }> = {
  OPEN: { label: "Waiting for explanation", cls: "STAGED" },
  EXPLAINED: { label: "Explained", cls: "PUBLISHED" },
  VOID: { label: "Doesn't count", cls: "REVERSED" },
};

/** One person's Late NTEs for a month, with the "issue an IR?" reminder. Management only. */
export default async function StaffNtePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ month?: string }> }) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const { supabase, access } = await requireAccess();
  const thisMonth = manilaToday().slice(0, 7);
  const sp = await searchParams;
  const ym = /^\d{4}-\d{2}$/.test(sp.month ?? "") && sp.month! <= thisMonth ? sp.month! : thisMonth;
  await supabase.rpc("run_nte_deadlines"); // automatic IRs that are due (update-0032)
  const [{ data }, { data: emp }] = await Promise.all([
    supabase.rpc("late_nte_list", { p_month: `${ym}-01`, p_employee: id }),
    supabase.from("employees").select("uid, full_name, position").eq("id", id).maybeSingle(),
  ]);
  const list = data as NteList | null;
  if (!list || !emp) notFound();
  const ntes = list.ntes.filter((n) => n.can_manage);
  if (list.ntes.length > 0 && ntes.length === 0) notFound();
  const counted = ntes.filter((n) => n.state !== "VOID");
  const notInIr = counted.filter((n) => !n.ir_id);
  const irs = [...new Set(counted.map((n) => n.ir_id).filter(Boolean))] as string[];
  const first = firstName(emp.full_name);
  const minutes = counted.reduce((t, n) => t + n.late_minutes, 0);
  const limit = list.ir_minutes ?? IR_MINUTES_DEFAULT;
  const due = notInIr.length > 0 && irReason(counted.length, minutes, limit) != null;
  const early = due && counted.length < IR_NTE_COUNT; // over the minutes limit before reaching 3 NTEs

  return (
    <>
      <TopBar access={access} />
      <main>
        <p><Link href={`/nte?month=${ym}`} className="small">← Tardiness tracker</Link></p>
        <h1>{emp.full_name} <Uid v={emp.uid} /></h1>
        <p className="muted small">{emp.position ?? "Staff"} · Late NTEs, {monthLabel(ym)}</p>

        {counted.length > 0 && (
          <div className={`card ${due ? "nte-reminder" : ""}`}>
            {notInIr.length > 0 ? (
              <IssueLateIrForm employee={id} month={`${ym}-01`}
                question={early
                  ? `${first} has been late ${minutes} minutes this month (${nteCount(counted.length)}), more than the ${limit}-minute limit. Do you want to issue an IR?`
                  : `${first} has been issued ${nteCount(counted.length)} this month (${minutes} minutes late)${irs.length ? `, ${notInIr.length} not in an IR yet` : ""}. ${due ? "Do you want to issue an IR?" : `An IR is suggested at ${IR_NTE_COUNT} Late NTEs or more than ${limit} minutes late. You can still issue one now.`}`} />
            ) : (
              <p style={{ margin: 0 }}><strong>{first} has been issued {nteCount(counted.length)} this month.</strong> All of them are already in an IR.</p>
            )}
            {irs.length > 0 && (
              <p className="small" style={{ marginBottom: 0 }}>IRs this month: {irs.map((ir, i) => <span key={ir}>{i > 0 && ", "}<Link href={`/incidents/${ir}`}>Open IR {i + 1}</Link></span>)}</p>
            )}
          </div>
        )}

        <div className="card">
          <h2>Late NTEs ({ntes.length})</h2>
          {ntes.length === 0 ? <p className="muted" style={{ margin: 0 }}>No Late NTEs this month.</p> : (
            <ul className="plain-list nte-list">
              {ntes.map((n) => (
                <li key={n.id}>
                  <div className="nte-body">
                    <span><strong>NTE no. {n.nte_no} · {dayLabel(n.work_date)}</strong> <span className={`pill ${STATE[n.state].cls}`}>{STATE[n.state].label}</span>
                      <br /><span className="small muted">Shift starts {timeLabel(n.shift_start)}, timed in {timeLabel(n.time_in)} ({n.late_minutes} minutes late){n.branch ? ` · ${n.branch}` : ""}{n.ir_id ? " · in an IR" : ""}</span></span>
                    {n.explanation && <p className="small" style={{ margin: 0 }}>Explanation: {n.explanation}</p>}
                    {n.state === "OPEN" && !n.ir_id && <NteDeadline n={n} />}
                    {n.state === "VOID" && <p className="small muted" style={{ margin: 0 }}>Doesn&apos;t count: {n.void_reason}</p>}
                  </div>
                  {n.state !== "VOID" && !n.ir_id && <VoidNteForm id={n.id} />}
                </li>
              ))}
            </ul>
          )}
        </div>
      </main>
    </>
  );
}
