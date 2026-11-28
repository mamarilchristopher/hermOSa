import Link from "next/link";
import { redirect } from "next/navigation";
import { branchesFor, can, requireAccess } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { centsToPhp } from "@/lib/csv";
import { ROLE_TEXT } from "@/lib/commission";
import { paidToLabel } from "@/lib/paidTo";
import { serviceLabel } from "@/lib/visit";
import { DecideButtons } from "../Forms";
import { EntryFiles } from "../EntryFiles";

type Log = {
  id: string; branch_id: string; service_date: string; amount_paid_cents: number; commission_type: string; performer_id: string; assistant_id: string | null;
  client_name: string | null; log_no: string | null; paid_to: string | null; visit_kind: string | null; session_no: number | null; merged_into: string | null;
  service_id: string | null; receipt_no: string | null; note: string | null; price_note: string | null; photos_due: boolean | null; created_by: string; created_at: string;
  services: { name: string; is_meds?: boolean; is_addon?: boolean } | null;
};
type Day = { branch_id: string; code: string; name: string; date: string; pending: number };
type Line = { service_log_id: string; employee_id: string; role: string; amount_cents: number };

const VISIT: Record<string, string> = { BACKJOB: "Backjob", CHECKUP: "Check-up", NO_CHARGE: "No charge" };
const dayText = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
const stamp = (ts: string) => new Date(ts).toLocaleString("en-US", { timeZone: "Asia/Manila", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** v0.106.4 (CHRIS Nov 28): the "Commission sign-off overdue" chips open here. Only the overdue entries of that branch and
 *  day (or of every overdue day), each with what's needed to decide and Approve / Reject. Nothing else. */
export default async function OverdueSignoffs({ searchParams }: { searchParams: Promise<{ date?: string; branch?: string }> }) {
  const { supabase, access, branches } = await requireAccess();
  const sp = await searchParams;
  if (branchesFor(access, branches, ["OWNER", "MANAGER"]).length === 0) redirect("/services");
  const { data: od } = await supabase.rpc("overdue_commission_days");
  const allDays = (Array.isArray(od) ? od : []) as Day[];
  // A chip names one branch and day: show only that. With no chip (or "+N more days"), every overdue day.
  const picked = !!(sp.date && sp.branch);
  const one = allDays.filter((d) => d.date === sp.date && d.code === sp.branch);
  const days = picked ? one : allDays;
  const others = allDays.length - one.length;
  const pickedName = branches.find((b) => b.code === sp.branch)?.name.replace(/ \(.*\)$/, "") ?? "This branch";

  const { data: logRows } = days.length
    ? await supabase.from("service_logs").select("*, services(name, is_meds, is_addon)").eq("state", "PENDING")
      .in("branch_id", [...new Set(days.map((d) => d.branch_id))]).in("service_date", [...new Set(days.map((d) => d.date))])
      .order("service_date").order("created_at")
    : { data: [] };
  const want = new Set(days.map((d) => `${d.branch_id}|${d.date}`));
  const logs = ((logRows ?? []) as unknown as Log[]).filter((l) => want.has(`${l.branch_id}|${l.service_date}`));
  const ids = new Set(logs.map((l) => l.id));
  // Meds / add-ons merged into a sale are decided with it, so they show inside it without their own buttons.
  const kids = new Map<string, Log[]>();
  for (const l of logs) if (l.merged_into && ids.has(l.merged_into)) kids.set(l.merged_into, [...(kids.get(l.merged_into) ?? []), l]);
  const mains = logs.filter((l) => !(l.merged_into && ids.has(l.merged_into)));

  const staffIds = [...new Set(logs.flatMap((l) => [l.performer_id, l.assistant_id]).filter((x): x is string => !!x))];
  const [{ data: lineRows }, { data: emps }, { data: ppl }] = await Promise.all([
    logs.length ? supabase.from("commission_lines").select("service_log_id, employee_id, role, amount_cents").in("service_log_id", [...ids]) : Promise.resolve({ data: [] }),
    staffIds.length ? supabase.from("employees").select("id, full_name, app_user_id").in("id", staffIds) : Promise.resolve({ data: [] }),
    supabase.rpc("chat_people"),
  ]);
  const lines = (lineRows ?? []) as Line[];
  const empName = new Map(((emps ?? []) as { id: string; full_name: string }[]).map((e) => [e.id, e.full_name]));
  const userName = new Map<string, string>([
    ...((Array.isArray(ppl) ? ppl : []) as { id: string; name: string }[]).map((x) => [x.id, x.name] as [string, string]),
    [access.user_id, "you"],
  ]);
  const branchName = new Map(days.map((d) => [d.branch_id, d.name.replace(/ \(.*\)$/, "")]));
  const groups = days.map((d) => ({ d, list: mains.filter((l) => l.branch_id === d.branch_id && l.service_date === d.date) })).filter((g) => g.list.length);
  const count = mains.length;

  return (
    <>
      <TopBar access={access} />
      <main className="overdue-page">
        <h1>Overdue sign-off</h1>
        <p className="muted small">
          {picked ? `${pickedName} · ${sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? dayText(sp.date) : ""} · ${count === 0 ? "all signed off" : `${count} ${count === 1 ? "entry" : "entries"} waiting`}`
            : count === 0 ? "Nothing overdue."
            : `${count} ${count === 1 ? "entry" : "entries"} waiting, oldest first`}
        </p>
        {count === 0 && (
          <p className="overdue-done">
            {picked && others > 0 && <Link className="button" href="/services/overdue">{others} more overdue {others === 1 ? "day" : "days"}</Link>}
            <Link className="button secondary" href="/me">Back to Home</Link>
          </p>
        )}
        {groups.map(({ d, list }) => (
          <section key={`${d.branch_id}-${d.date}`} className="overdue-group">
            {!picked && <h2>{branchName.get(d.branch_id)} · {dayText(d.date)}</h2>}
            {list.map((l) => {
              const sub = kids.get(l.id) ?? [];
              const total = [l, ...sub].reduce((s, x) => s + Number(x.amount_paid_cents), 0);
              const kind = l.visit_kind ?? "PAID";
              const extra = !!(l.services?.is_meds || l.services?.is_addon);
              const needsWaiver = !extra && (kind === "PAID" || kind === "BACKJOB");
              const staff = [l.performer_id, l.assistant_id].filter((x): x is string => !!x);
              const seesFiles = can(access, ["OWNER", "MANAGER", "CLINICIAN", "CASHIER"], l.branch_id);
              return (
                <article key={l.id} className="card overdue-entry">
                  <div className="overdue-head">
                    <div>
                      <strong>{l.client_name ?? "No client name"}</strong>
                      {l.log_no && <span className="muted small"> · {l.log_no}</span>}
                    </div>
                    <strong className="overdue-amt">{centsToPhp(total)}</strong>
                  </div>
                  <ul className="plain-list overdue-items">
                    {[l, ...sub].map((x) => (
                      <li key={x.id}>
                        <span>{(x.session_no ?? 1) > 1 && <span className="session-tag">Session {x.session_no}</span>} {serviceLabel(x.services?.name ?? "Service", x.visit_kind, Number(x.amount_paid_cents))}
                          {x.visit_kind && x.visit_kind !== "PAID" && <span className="muted small"> · {VISIT[x.visit_kind] ?? x.visit_kind}</span>}</span>
                        <span className="muted">{centsToPhp(x.amount_paid_cents)}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="overdue-staff">
                    {staff.length === 0 ? <span className="small muted">No staff</span> : staff.map((id, i) => {
                      const mine = lines.filter((x) => x.employee_id === id && (x.service_log_id === l.id || sub.some((k) => k.id === x.service_log_id)));
                      const amt = mine.reduce((s, x) => s + Number(x.amount_cents), 0);
                      const role = mine[0] ? ROLE_TEXT[mine[0].role] : l.commission_type === "LEAD" ? (i === 0 ? "lead" : "assist") : l.commission_type === "SOLO" ? "solo" : "";
                      return (
                        <div key={id} className="overdue-person">
                          <span>{empName.get(id) ?? "Former staff"}</span>
                          <span>{mine.length ? <><strong>{centsToPhp(amt)}</strong> <span className="muted small">{role}</span></> : <span className="muted small">no commission{role ? ` · ${role}` : ""}</span>}</span>
                        </div>
                      );
                    })}
                  </div>
                  <div className="small muted overdue-meta">
                    {(kind === "PAID" || kind === "BACKJOB") && paidToLabel(l.paid_to) && <span>Paid to <strong>{paidToLabel(l.paid_to)}</strong></span>}
                    {l.receipt_no && <span>Waiver / OR {l.receipt_no}</span>}
                    {l.price_note && <span>Price: {l.price_note}</span>}
                    {l.note && <span>{l.note}</span>}
                    <span>Entered by {userName.get(l.created_by) ?? "staff"} · {stamp(l.created_at)}</span>
                    {l.photos_due && <span className="pill REVERSED">Photos missing</span>}
                  </div>
                  {seesFiles && <EntryFiles log={l.id} more={sub.map((k) => k.id)} auto needsWaiver={needsWaiver && !l.photos_due} />}
                  <div className="overdue-decide"><DecideButtons id={l.id} /></div>
                </article>
              );
            })}
          </section>
        ))}
      </main>
    </>
  );
}
