import { sortServices } from "@/lib/serviceOrder";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAccess, branchesFor, can } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { centsToPhp } from "@/lib/csv";
import { isIsoDate, manilaToday } from "@/lib/dates";
import { addDays, sortBranches, WEEKDAYS, weekday } from "@/lib/insights";
import { ROLE_TEXT, TYPE_TEXT } from "@/lib/commission";
import { BatchApprove, DecideButtons, EntryForm } from "./Forms";
import { DeclaredCheck, diffText } from "./DeclaredCheck";
import { CHECK_FROM, CHECK_TO, checkBranches, inCheckWindow, type StatusDay } from "@/lib/declaredCheck";
import { AddPhotosLater } from "./PhotoSlots";

type Log = {
  id: string; service_date: string; amount_paid_cents: number; commission_type: string; performer_id: string; assistant_id: string | null;
  receipt_no: string | null; note: string | null; branch_id?: string; client_name?: string | null; price_note?: string | null; photo_folder?: string | null; share_ok?: boolean; photos_due?: boolean; session_no?: number; state: string; visit_kind?: string; created_by: string; created_at: string; decision_note: string | null;
  services: { name: string } | null;
};
const VISIT_TEXT: Record<string, string> = { BACKJOB: "Backjob (unpaid)", CHECKUP: "Check-up (unpaid)", NO_CHARGE: "No charge" };
type Line = { service_log_id: string; employee_id: string; role: string; amount_cents: number };

export default async function ServiceLog({ searchParams }: { searchParams: Promise<{ date?: string; branch?: string; entry?: string; days?: string }> }) {
  const { supabase, access, branches } = await requireAccess();
  const sp = await searchParams;
  const viewable = branchesFor(access, branches, ["OWNER", "FINANCE", "MANAGER", "CASHIER", "CLINICIAN", "HR", "AUDITOR"]);
  if (viewable.length === 0) redirect("/");
  const branch = viewable.find((b) => b.code === sp.branch) ?? viewable[0];
  const today = manilaToday();
  const date = isIsoDate(sp.date) && sp.date <= today ? sp.date : today;
  // CHRIS Nov 26: entries grouped by day, the last 7 days up to the chosen day, with "Show 7 more days".
  const days = Math.min(91, Math.max(7, Math.round(Number(sp.days) / 7) * 7 || 7));
  const from = addDays(date, -(days - 1));
  const canLog = can(access, ["OWNER", "FINANCE", "MANAGER", "CASHIER", "CLINICIAN"], branch.id);
  const approver = can(access, ["OWNER", "MANAGER"], branch.id);
  // Owners and the GM (update-0054) may log without photos; the lead and assist add them later.
  const topMgmt = can(access, ["OWNER"], null) || can(access, ["MANAGER"], null);
  const isManager = can(access, ["OWNER", "MANAGER"], null) || branchesFor(access, branches, ["MANAGER"]).length > 0;

  const [{ data: services }, { data: emps }, { data: logs }, { data: ppl }] = await Promise.all([
    supabase.from("services").select("id, name, price_cents, commission_cents").eq("active", true).order("name"),
    supabase.from("employees").select("id, full_name, branch_id, commission_eligible, app_user_id, position").eq("active", true).order("full_name"),
    supabase.from("service_logs").select("*, services(name)")
      .eq("branch_id", branch.id).gte("service_date", from).lte("service_date", date).order("service_date", { ascending: false }).order("created_at"),
    supabase.rpc("chat_people"), // names of everyone in the company, for "Entered by"
  ]);
  const all = (logs ?? []) as unknown as Log[];
  // CHRIS Nov 26: owners and the GM see a running Nov 1–24 check against the declared sales.
  const { data: declaredData } = topMgmt ? await supabase.rpc("daily_sales_status", { p_start: CHECK_FROM, p_end: CHECK_TO }) : { data: null };
  const declared = declaredData as { ok: boolean; branches: { id: string; code: string; name: string }[]; days: StatusDay[] } | null;
  const checkList = declared?.ok ? sortBranches(declared.branches) : [];
  const checks = checkBranches(declared?.days ?? [], checkList.map((b) => b.id)).map((c) => ({ ...c, code: checkList.find((b) => b.id === c.branch)!.code }));
  const checkNames = Object.fromEntries(checkList.map((b) => [b.id, b.name]));
  const dayCheck = new Map((checks.find((c) => c.branch === branch.id)?.days ?? []).map((d) => [d.date, d]));
  const list = all.filter((l) => l.service_date === date); // the chosen day, for the cards on top
  // update-0054 (CHRIS Nov 26): only staff timed in today add entries; owners and the GM always can.
  const { data: onDuty } = canLog && !topMgmt ? await supabase.rpc("can_log_services_now") : { data: true };
  const { data: lineRows } = all.length
    ? await supabase.from("commission_lines").select("service_log_id, employee_id, role, amount_cents").in("service_log_id", all.map((l) => l.id))
    : { data: [] as Line[] };
  const lines = (lineRows ?? []) as Line[];
  const name = Object.fromEntries((emps ?? []).map((e) => [e.id, e.full_name]));
  // CHRIS Nov 26: who entered each entry, and when.
  const userName = new Map<string, string>([
    ...(emps ?? []).filter((e) => e.app_user_id).map((e) => [e.app_user_id as string, e.full_name] as [string, string]),
    ...((Array.isArray(ppl) ? ppl : []) as { id: string; name: string }[]).map((x) => [x.id, x.name] as [string, string]),
    [access.user_id, access.display_name],
  ]);
  // Time it was entered; the date too when it was entered on a later day than the service.
  const enteredAt = (ts: string, day: string) => {
    const d = new Date(ts), t = d.toLocaleTimeString("en-PH", { timeZone: "Asia/Manila", hour: "numeric", minute: "2-digit" });
    return manilaToday(d) === day ? t : `${d.toLocaleDateString("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric" })}, ${t}`;
  };
  const mine = new Set((emps ?? []).filter((e) => e.app_user_id === access.user_id).map((e) => e.id));
  // CHRIS Nov 26: the General Manager doesn't perform services, so she isn't in the Lead / Assisted by lists.
  const clinicIds = new Set(branches.filter((b) => b.kind === "CLINIC").map((b) => b.id));
  // CHRIS Nov 26: only clinic staff in these lists (no CSRs / WFH staff).
  const employees = (emps ?? []).filter((e) => !/general\s*manager/i.test(e.position ?? "") && !/\bcsr\b/i.test(e.position ?? "") && clinicIds.has(e.branch_id)).map((e) => ({ id: e.id, name: e.full_name, eligible: e.commission_eligible, here: e.branch_id === branch.id }));
  // Staff who aren't on commission never see commission choices (management still does, to log for others).
  const myEmp = (emps ?? []).find((e) => e.app_user_id === access.user_id);
  const noCommission = !!myEmp && !myEmp.commission_eligible && !access.grants.some((g) => ["OWNER", "FINANCE", "MANAGER", "AUDITOR"].includes(g.role));

  const paid = list.filter((l) => l.state !== "REJECTED").reduce((s, l) => s + Number(l.amount_paid_cents), 0);
  const commission = lines.filter((x) => list.find((l) => l.id === x.service_log_id)?.state !== "REJECTED").reduce((s, x) => s + Number(x.amount_cents), 0);
  const pendingCount = list.filter((l) => l.state === "PENDING").length;
  const pendingAll = all.filter((l) => l.state === "PENDING").length;
  const groups = [...new Set(all.map((l) => l.service_date))].map((d) => [d, all.filter((l) => l.service_date === d)] as const);
  const link = (d: string, b = branch.code) => `/services?date=${d}&branch=${b}`;
  const dayLabel = `${WEEKDAYS[weekday(date)]}, ${new Date(`${date}T00:00:00Z`).toLocaleDateString("en-PH", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })}`;

  return (
    <>
      <TopBar access={access} />
      <main>
        <h1>Service Log</h1>
        <p className="muted small">{noCommission ? "Every service done today and who did it. A manager signs off each entry." : "Every service done today, who did it and the commission. A manager signs off each entry."}</p>

        <div className="periods card">
          <div className="segmented" aria-label="Branch">
            {viewable.map((b) => <Link key={b.id} href={link(date, b.code)} className={b.id === branch.id ? "on" : ""}>{b.name}</Link>)}
          </div>
          <form className="day-nav">
            <input type="hidden" name="branch" value={branch.code} />
            <Link className="button secondary small" href={link(addDays(date, -1))} aria-label="Previous day">←</Link>
            <input type="date" name="date" defaultValue={date} max={today} aria-label="Date" />
            <button type="submit" className="secondary small">Go</button>
            {date < today && <Link className="button secondary small" href={link(addDays(date, 1))} aria-label="Next day">→</Link>}
            {date !== today && <Link className="button secondary small" href={link(today)}>Today</Link>}
          </form>
        </div>

        <div className="grid">
          <div className="card stat hero"><div className="label">{branch.name} · {dayLabel}</div><div className="value">{centsToPhp(paid)}</div><div className="note">{(() => { const ok = list.filter((l) => l.state !== "REJECTED"); const unpaid = ok.filter((l) => l.visit_kind && l.visit_kind !== "PAID").length; return `${ok.length - unpaid} paid services${unpaid ? `, ${unpaid} unpaid visit${unpaid === 1 ? "" : "s"}` : ""}`; })()}</div></div>
          {approver && <div className="card stat"><div className="label">Commission</div><div className="value">{centsToPhp(commission)}</div><div className="note">5% of amount paid, lead 60 / assist 40</div></div>}
          <div className="card stat"><div className="label">Sign-off</div><div className="value">{pendingCount === 0 ? (list.length ? "All signed" : "–") : `${pendingCount} waiting`}</div><div className="note">{approver ? "Approve entries below, one by one or together" : "Your manager signs these off"}</div></div>
        </div>

        {checks.length > 0 && <DeclaredCheck checks={checks} names={checkNames} current={branch.id} open={inCheckWindow(date)} day={inCheckWindow(date) ? date : CHECK_TO} link={link} />}

        {canLog && (
          <div className="card">
            <h2>Add a service</h2>
            {onDuty === false ? (
              <div className="notice info">Time in first to add services. Only staff who are timed in today can add to the Service log. <Link href="/time">Go to Time clock</Link></div>
            ) : (services ?? []).length === 0 || employees.length === 0 ? (
              <div className="notice info">
                {employees.length === 0 ? <>Add the branch&apos;s staff first on <Link href="/people">Employees</Link>. </> : null}
                {(services ?? []).length === 0 ? "Add your services below first." : null}
              </div>
            ) : (
              <EntryForm branch={branch.id} date={date} today={today} services={sortServices(services ?? []).map((s) => ({ id: s.id, name: s.name, price: s.price_cents ?? null, commission: s.commission_cents ?? null }))} employees={employees} noCommission={noCommission} photosOptional={topMgmt} />
            )}
            {isManager && <p className="small" style={{ marginTop: 12 }}><Link href="/services/prices">Price list and commissions</Link> (add a service, set its price and commission)</p>}
          </div>
        )}

        <h2>Entries</h2>
        {approver && pendingAll > 1 && <BatchApprove ids={all.filter((l) => l.state === "PENDING").map((l) => l.id)} />}
        {groups.length === 0 && <p className="muted">Nothing logged in these {days} days.</p>}
        {groups.map(([d, dayList]) => {
          const ok = dayList.filter((l) => l.state !== "REJECTED");
          const waiting = dayList.filter((l) => l.state === "PENDING").length;
          return (
            <section key={d} className="log-day">
              <h3 className="log-day-head">
                <span>{d === today ? "Today" : d === addDays(today, -1) ? "Yesterday" : WEEKDAYS[weekday(d)]}, {new Date(`${d}T00:00:00Z`).toLocaleDateString("en-PH", { month: "short", day: "numeric", timeZone: "UTC" })}</span>
                <span className="small muted">{ok.length} entr{ok.length === 1 ? "y" : "ies"} · {centsToPhp(ok.reduce((x, l) => x + Number(l.amount_paid_cents), 0))}{waiting ? ` · ${waiting} waiting` : ""}
                  {dayCheck.has(d) && <span className={`check-note ${dayCheck.get(d)!.status}`}> · {diffText(dayCheck.get(d)!)}</span>}</span>
              </h3>
        <div className="table-wrap">
          <table className="log-table">
            <thead>
              <tr><th>Service</th><th className="num">Paid</th><th>Type</th><th>Staff</th><th className="num">{noCommission ? "Role" : "Commission"}</th><th>Status</th></tr>
            </thead>
            <tbody>
              {dayList.map((l) => {
                const ls = lines.filter((x) => x.service_log_id === l.id);
                const staff = [l.performer_id, l.assistant_id].filter(Boolean) as string[];
                return (
                  <tr key={l.id} id={`entry-${l.id}`} className={[l.state === "REJECTED" ? "rejected" : "", sp.entry === l.id ? "entry-focus" : ""].join(" ").trim() || undefined}>
                    <td>{l.state === "PENDING" && approver && pendingAll > 1 && (
                        <input type="checkbox" className="batch-tick" name="pick" value={l.id} form="batch-approve" aria-label={`Tick ${l.client_name ?? "entry"} to approve`} />
                      )}
                      {l.client_name && <div className="log-client">{l.client_name}</div>}<strong>{(l.session_no ?? 1) > 1 && <span className="session-tag">Session {l.session_no}</span>}{l.services?.name}</strong>
                      {l.receipt_no && <div className="small muted">Waiver / OR {l.receipt_no}</div>}
                      {l.price_note && <div className="small muted">Price: {l.price_note}</div>}
                      {l.note && <div className="small muted">{l.note}</div>}
                      {l.photos_due && l.state !== "REJECTED" && (
                        <div className="photos-due">
                          <span className="pill REVERSED">Photos missing</span>
                          {!noCommission && <span className="small muted"> Commission held until they&apos;re added.</span>}
                          {(topMgmt || l.created_by === access.user_id || staff.some((x) => mine.has(x))) && (
                            <AddPhotosLater log={l.id} branch={l.branch_id ?? branch.id} folder={l.photo_folder ?? null} needs="before and after photos and both waiver pages" />
                          )}
                        </div>
                      )}
                      <div className="log-by small"><span className="muted">Entered by</span> {l.created_by === access.user_id ? "you" : userName.get(l.created_by) ?? "a former user"} <span className="muted">· {enteredAt(l.created_at, l.service_date)}</span></div>
                      {l.photo_folder && l.client_name && <div className="small"><Link href={`/clinic/archive?month=${l.service_date.slice(0, 7)}#${l.id}`}>Photos</Link>{l.share_ok ? <span className="muted"> · sharing OK</span> : null}</div>}</td>
                    <td className="num">{centsToPhp(l.amount_paid_cents)}</td>
                    <td>{l.visit_kind && l.visit_kind !== "PAID"
                      ? <span className="tag">{VISIT_TEXT[l.visit_kind] ?? l.visit_kind}</span>
                      : <span className={`tag ${l.commission_type}`}>{TYPE_TEXT[l.commission_type]}</span>}</td>
                    {/* v0.49 (CHRIS Nov 26): staff and commission in their own columns, one line per person, aligned. */}
                    <td>
                      {staff.map((id) => (
                        <div key={id} className="staff-line">{name[id] ?? "Former staff"}{mine.has(id) && <span className="muted"> (you)</span>}</div>
                      ))}
                    </td>
                    <td className="num">
                      {staff.map((id, i) => {
                        const line = ls.find((x) => x.employee_id === id);
                        const role = l.commission_type === "LEAD" ? (i === 0 ? "lead" : "assist") : l.commission_type === "SOLO" ? "solo" : "";
                        return (
                          <div key={id} className="staff-line comm">
                            {noCommission ? <span className="muted small">{role || "-"}</span> : line ? <><strong>{centsToPhp(line.amount_cents)}</strong> <span className="muted small">{ROLE_TEXT[line.role]}</span></>
                              : <span className="muted small">{l.commission_type === "NONCOMMI" ? "-" : approver || mine.has(id) ? `no commission · ${role}` : role}</span>}
                          </div>
                        );
                      })}
                    </td>
                    <td>
                      {l.state === "PENDING" && approver ? <DecideButtons id={l.id} /> : (
                        <span className={`pill ${l.state === "APPROVED" ? "PUBLISHED" : l.state === "REJECTED" ? "REVERSED" : "STAGED"}`}>
                          {l.state === "APPROVED" ? "Approved" : l.state === "REJECTED" ? "Rejected" : "Waiting"}
                        </span>
                      )}
                      {l.state === "REJECTED" && l.decision_note && <div className="small muted">{l.decision_note}</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
            </section>
          );
        })}
        <p className="log-more">{days < 91 && <Link className="button secondary" href={`${link(date)}&days=${days + 7}`} scroll={false}>Show 7 more days</Link>}
          <span className="small muted"> Showing the {days} days up to {date === today ? "today" : dayLabel}.</span></p>
      </main>
    </>
  );
}
