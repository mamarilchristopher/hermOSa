import { AddPanel } from "@/components/Controls";
import Link from "next/link";
import { can, requireAccess } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { Uid } from "@/components/Uid";
import { manilaToday } from "@/lib/dates";
import { CancelLeaveButton, DecideLeaveForm, FileLeaveForm } from "./Forms";

type Leave = {
  id: string; employee_id: string; kind: "VL" | "SL"; start_date: string; end_date: string; reason: string;
  state: "PENDING" | "APPROVED" | "DECLINED" | "CANCELLED"; with_pay: boolean | null; days: number | null; note: string | null; filed_at: string;
};
type Emp = { id: string; uid?: string; full_name: string; app_user_id: string | null; branch_id: string };

const KIND = { VL: "Vacation leave", SL: "Sick leave" } as const;
const STATE: Record<Leave["state"], [string, string]> = {
  PENDING: ["Waiting", "STAGED"], APPROVED: ["Approved", "PUBLISHED"], DECLINED: ["Not approved", "REVERSED"], CANCELLED: ["Withdrawn", "REVERSED"],
};
const fmt = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-PH", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
const range = (l: Leave) => (l.end_date > l.start_date ? `${fmt(l.start_date)} to ${fmt(l.end_date)}` : fmt(l.start_date));
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const dayCount = (l: Leave) => (l.days == null ? "" : ` · ${l.days} working day${l.days === 1 ? "" : "s"}`);

/** Leave requests (update-0035): staff file VL/SL; owners and the General Manager approve and the schedule updates itself. */
export default async function LeavePage() {
  const { supabase, access, branches } = await requireAccess();
  const owner = can(access, ["OWNER"], null);
  const approver = owner || can(access, ["MANAGER"], null);
  const today = manilaToday();
  const year = today.slice(0, 4);
  const [{ data: me }, { data, error }, { data: emps }] = await Promise.all([
    supabase.from("employees").select("id").eq("app_user_id", access.user_id).eq("active", true).maybeSingle(),
    supabase.from("leave_requests").select("id, employee_id, kind, start_date, end_date, reason, state, with_pay, days, note, filed_at").order("start_date", { ascending: false }).limit(300),
    supabase.from("employees").select("id, uid, full_name, app_user_id, branch_id"),
  ]);
  const rows = (data ?? []) as Leave[];
  const who = new Map(((emps ?? []) as Emp[]).map((e) => [e.id, e]));
  const branchName = new Map(branches.map((b) => [b.id, b.name]));
  const mine = me ? rows.filter((r) => r.employee_id === me.id) : [];
  const waiting = rows.filter((r) => r.state === "PENDING" && r.employee_id !== me?.id).sort((a, b) => a.start_date.localeCompare(b.start_date));
  const decided = rows.filter((r) => r.state === "APPROVED" && r.employee_id !== me?.id).slice(0, 30);
  // Paid leave days already used this year, per person (Service Incentive Leave is 5 paid days a year after 1 year of service).
  const paidUsed = new Map<string, number>();
  for (const r of rows) if (r.state === "APPROVED" && r.with_pay && r.start_date.startsWith(year)) paidUsed.set(r.employee_id, (paidUsed.get(r.employee_id) ?? 0) + (r.days ?? 0));
  const myPaid = me ? paidUsed.get(me.id) ?? 0 : 0;

  return (
    <>
      <TopBar access={access} />
      <main>
        <h1>Leave</h1>
        <p className="muted small">File vacation or sick leave here. An owner or the General Manager approves it, and your schedule updates by itself.</p>
        {error && <div className="notice info">{error.code === "42P01" ? "The owner needs to run update-0035 in Supabase first." : "Could not load. Try again."}</div>}

        {approver && (
          <div className="card">
            <h2>Waiting for you ({waiting.length})</h2>
            {waiting.length === 0 && <p className="muted small" style={{ margin: 0 }}>Nothing to approve.</p>}
            {waiting.map((r) => {
              const e = who.get(r.employee_id);
              const self = e?.app_user_id === access.user_id;
              return (
                <div key={r.id} className="leave-review">
                  <p style={{ margin: "0 0 4px" }}>
                    <strong>{e?.full_name ?? "Staff"}</strong><Uid v={e?.uid} /> <span className="small muted">{e ? branchName.get(e.branch_id) : ""}</span>
                  </p>
                  <p style={{ margin: "0 0 4px" }}><strong>{KIND[r.kind]}</strong>, {range(r)}{dayCount(r)}</p>
                  <p className="small" style={{ margin: "0 0 4px" }}>“{r.reason}”</p>
                  <p className="small muted" style={{ margin: "0 0 8px" }}>Paid leave used in {year}: {paidUsed.get(r.employee_id) ?? 0} day{(paidUsed.get(r.employee_id) ?? 0) === 1 ? "" : "s"} (the law gives 5 paid days a year after 1 year of service).</p>
                  {self && !owner ? <p className="small muted">Yours: an owner approves it.</p> : <DecideLeaveForm id={r.id} />}
                </div>
              );
            })}
          </div>
        )}

        {me ? (
          <AddPanel title="File leave" hint="Vacation or sick leave, for you">
            <FileLeaveForm today={today} slFrom={addDays(today, -14)} />
          </AddPanel>
        ) : (
          <div className="notice info">Your account isn&apos;t linked to an employee record yet, so you can&apos;t file leave. Ask an owner.</div>
        )}

        {me && (
          <div className="card">
            <h2>My leave</h2>
            <p className="small muted" style={{ marginTop: 0 }}>Paid leave used in {year}: {myPaid} day{myPaid === 1 ? "" : "s"}.</p>
            {mine.length === 0 && <p className="muted small" style={{ margin: 0 }}>No leave filed yet.</p>}
            <ul className="plain-list">
              {mine.map((r) => (
                <li key={r.id}>
                  <span>
                    <strong>{r.kind}</strong> {range(r)}{dayCount(r)}
                    {r.state === "APPROVED" && <span className="small muted"> · {r.with_pay ? "with pay" : "without pay"}</span>}
                    {r.note && <span className="small muted"> · {r.note}</span>}
                    {r.state === "APPROVED" && <> · <Link className="small" href={`/schedule?week=${weekStart(r.start_date)}`}>See schedule</Link></>}
                  </span>
                  <span>
                    {r.state === "PENDING" && <CancelLeaveButton id={r.id} />}{" "}
                    <span className={`pill ${STATE[r.state][1]}`}>{STATE[r.state][0]}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {approver && decided.length > 0 && (
          <div className="card">
            <h2>Approved leave</h2>
            <ul className="plain-list">
              {decided.map((r) => {
                const e = who.get(r.employee_id);
                return (
                  <li key={r.id}>
                    <span>{e?.full_name ?? "Staff"}<Uid v={e?.uid} /> · <strong>{r.kind}</strong> {range(r)}{dayCount(r)}</span>
                    <span className="small muted">{r.with_pay ? "With pay" : "Without pay"}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </main>
    </>
  );
}

/** Monday of the week holding this date (the schedule's week starts Monday). */
function weekStart(d: string) {
  const t = new Date(`${d}T00:00:00Z`);
  const back = (t.getUTCDay() + 6) % 7;
  return new Date(t.getTime() - back * 86400000).toISOString().slice(0, 10);
}
