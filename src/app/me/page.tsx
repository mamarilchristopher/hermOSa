import Link from "next/link";
import { requireAccess } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { Reveal } from "@/components/Reveal";
import { centsToPhp } from "@/lib/csv";
import { manilaToday } from "@/lib/dates";
import { monthEnd, monthLabel, monthStart } from "@/lib/insights";
import { ROLE_TEXT } from "@/lib/commission";
import { markNoticesRead } from "./actions";
import { ManagerHome, TodoCard, type Todo } from "./ManagerHome";
import type { DutyRow } from "@/components/OnDuty";
import type { Ir } from "@/lib/incidents";
import { branchShort, timeLabel } from "@/lib/schedule";
import { noticeButton, noticeHref } from "@/lib/noticeLink";
import { computeGlance, cutoffEnd, dayLabel, glanceFetchStart, type StatusDay } from "@/lib/homeGlance";
import { addDays, sortBranches } from "@/lib/insights";
import { missingRequired, type Details } from "@/lib/employeeDetails";
import { firstName, times, tracker, type NteList } from "@/lib/nte";
import { NteExplainForm } from "../nte/Forms";
import { Uid } from "@/components/Uid";

type Signoffs = { to_sign: { count: number; oldest: string | null }; mine: { count: number; oldest: string | null } };
type DailyStatus = { ok: boolean; branches?: { id: string; code: string; name: string }[]; days?: StatusDay[];
  corrections?: { id: string; mine: boolean }[] };

/** Everything the management Home needs, in one round of queries. Missing pieces (older database) just drop out. */
async function managementHome(supabase: Awaited<ReturnType<typeof requireAccess>>["supabase"], today: string, owner: boolean, userId: string, gm = false) {
  const [{ data: st }, { data: overdueData }, { data: signData }, { count: uploads }, { count: details }, { count: joins }, { data: dutyData }, { count: schedReqs }, { data: irData }] = await Promise.all([
    supabase.rpc("daily_sales_status", { p_start: glanceFetchStart(today), p_end: today }),
    supabase.rpc("overdue_commission_days"),
    supabase.rpc("pending_signoffs"),
    supabase.from("import_batches").select("id", { count: "exact", head: true }).eq("state", "STAGED"),
    owner || gm ? supabase.from("employee_detail_submissions").select("id", { count: "exact", head: true }).eq("state", "PENDING").neq("user_id", userId) : Promise.resolve({ count: 0 }),
    supabase.from("app_users").select("id", { count: "exact", head: true }).eq("join_status", "PENDING"), // owner, or GM after update-0027

    supabase.rpc("on_duty", { p_date: today }), // errors (before update-0022) mean no On Duty card
    supabase.from("schedule_requests").select("id", { count: "exact", head: true }).eq("state", "PENDING").neq("requested_by", userId),
    supabase.rpc("incident_list"), // errors (before update-0023) mean no IR to-dos
  ]);
  const s = (st ?? { ok: false }) as DailyStatus;
  if (!s.ok) return null;
  const g = computeGlance(today, sortBranches(s.branches ?? []), s.days ?? []);
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const todos: Todo[] = [];
  if (g.yesterdayMissing.length) todos.push({ text: `Yesterday's sales not entered yet: ${g.yesterdayMissing.join(", ")}`, href: "/sales/daily", urgent: true });
  const olderEmpty = g.emptyDays - g.yesterdayMissing.length;
  if (olderEmpty > 0) todos.push({ text: `${plural(olderEmpty, "earlier day", "earlier days")} this month with nothing entered (enter the total or mark Zero sales / Closed)`, href: "/sales/daily" });
  const changes = (s.corrections ?? []).filter((c) => !c.mine).length;
  if (changes) todos.push({ text: `${plural(changes, "sales change needs", "sales changes need")} a second person to confirm`, href: "/sales/daily", urgent: true });
  const overdue = (Array.isArray(overdueData) ? overdueData : []) as { name: string; date: string; pending: number }[];
  if (overdue.length) todos.push({ text: `Commission sign-off overdue: ${overdue.slice(0, 4).map((o) => `${o.name.replace(/ \(.*\)$/, "")} ${dayLabel(o.date).slice(5)}`).join(", ")}${overdue.length > 4 ? ", and more" : ""}`, href: "/services", urgent: true });
  const toSign = (signData as Signoffs | null)?.to_sign;
  if (toSign?.count) todos.push({
    text: `Sign off ${plural(toSign.count, "commission entry", "commission entries")} (oldest ${dayLabel(toSign.oldest!)}). Anything unsigned by ${dayLabel(cutoffEnd(today))} isn't paid in this cutoff`,
    href: `/services?date=${toSign.oldest}`, urgent: !overdue.length });
  if (uploads) todos.push({ text: `${plural(uploads, "upload is", "uploads are")} waiting for sign-off`, href: "/imports" });
  if (details) todos.push({ text: `${plural(details, "staff member sent", "staff members sent")} employee details to review`, href: "/admin/details" });
  if (joins) todos.push({ text: `${plural(joins, "person is", "people are")} asking to join the app`, href: owner ? "/admin/users" : "/admin/joins" });
  if (schedReqs) todos.push({ text: `${plural(schedReqs, "schedule change is", "schedule changes are")} waiting for approval (swaps or day-off moves)`, href: "/schedule" });
  const irs = ((irData as { reports?: Ir[] } | null)?.reports ?? []).filter((r) => r.can_manage);
  const irDraft = irs.filter((r) => r.state === "DRAFT").length, irExplained = irs.filter((r) => r.state === "EXPLAINED").length;
  if (irDraft) todos.push({ text: `${plural(irDraft, "tardiness IR is", "tardiness IRs are")} ready to review and issue`, href: "/incidents", urgent: true });
  if (irExplained) todos.push({ text: `${plural(irExplained, "IR has", "IRs have")} an explanation. Close with the action taken`, href: "/incidents" });
  const duty = Array.isArray(dutyData) ? (dutyData as DutyRow[]) : null;
  if (duty) {
    const hm = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Manila" });
    const notIn = duty.filter((r) => !r.off && r.start && !r.time_in && r.start.slice(0, 5) <= hm);
    if (notIn.length) todos.push({ text: `Not timed in yet: ${notIn.slice(0, 5).map((r) => r.name.split(" ")[0]).join(", ")}${notIn.length > 5 ? ", and more" : ""}`, href: "/time", urgent: true });
  }
  return { g, todos, duty };
}

type Notice = { id: string; kind?: string; title: string; body: string | null; link: string | null; created_at: string; read_at: string | null };
const when = (iso: string) => new Date(iso).toLocaleString("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

const ROLE_LABEL: Record<string, string> = {
  OWNER: "Owner", FINANCE: "Finance", MANAGER: "Manager", CASHIER: "Front desk", HR: "HR",
  MARKETING: "Marketing", CLINICIAN: "Clinician", INVENTORY: "Inventory", AUDITOR: "Auditor",
};

type Line = { role: string; amount_cents: number; service_logs: { service_date: string; state: string; services: { name: string } | null } };

/** Staff Home: your own details and, for commission staff, this month's running commission (covered until tapped). */
export default async function Me() {
  const { supabase, access, branches } = await requireAccess();
  const today = manilaToday();
  const start = monthStart(today), ym = today.slice(0, 7);
  const [{ data: emp }, { data: user }, { data: subs }, { data: noticeData }] = await Promise.all([
    supabase.from("employees").select("id, uid, full_name, branch_id, position, commission_eligible, active").eq("app_user_id", access.user_id).maybeSingle(),
    supabase.from("app_users").select("uid, email, joined_at").eq("id", access.user_id).maybeSingle(),
    supabase.from("employee_detail_submissions").select("state, note, data").eq("user_id", access.user_id).neq("state", "SUPERSEDED")
      .order("submitted_at", { ascending: false }).limit(1),
    supabase.from("notifications").select("id, kind, title, body, link, created_at, read_at").order("created_at", { ascending: false }).limit(15),
  ]);
  const notices = (noticeData ?? []) as Notice[];
  const unread = notices.filter((n) => !n.read_at).length;
  const detailState = subs?.[0]?.state as string | undefined;
  // Sent before new required fields were added: ask only for what's missing.
  const missing = detailState === "APPROVED" || detailState === "PENDING" ? missingRequired((subs?.[0]?.data ?? {}) as Details) : [];
  const missingTodo: Todo | null = missing.length ? { text: `Your employee details need ${missing.length <= 3 ? missing.map((f) => f.label.replace(/\s*\(.*\)/, "")).join(", ") : `${missing.length} more items`}. Please add them`, href: "/me/details" } : null;
  const { data } = emp?.commission_eligible
    ? await supabase.from("commission_lines").select("role, amount_cents, service_logs!inner(service_date, state, services(name))")
        .eq("employee_id", emp.id).gte("service_logs.service_date", start).lte("service_logs.service_date", monthEnd(start))
    : { data: [] };
  const lines = (data ?? []) as unknown as Line[];
  const sum = (state: string) => lines.filter((l) => l.service_logs.state === state).reduce((s, l) => s + Number(l.amount_cents), 0);
  const approved = sum("APPROVED"), waiting = sum("PENDING");
  const recent = lines.filter((l) => l.service_logs.state !== "REJECTED")
    .sort((a, b) => b.service_logs.service_date.localeCompare(a.service_logs.service_date)).slice(0, 5);
  const branchName = Object.fromEntries(branches.map((b) => [b.id, b.name]));
  const scope = access.grants.map((g) => `${ROLE_LABEL[g.role] ?? g.role}, ${g.branch_id ? branchName[g.branch_id] ?? "branch" : "all branches"}`);
  const isOwner = access.grants.some((g) => g.role === "OWNER");
  const first = (emp?.full_name || access.display_name).trim().split(/\s+/)[0];
  const management = access.grants.some((g) => ["OWNER", "FINANCE", "MANAGER", "AUDITOR"].includes(g.role));
  const logger = access.grants.some((g) => ["OWNER", "FINANCE", "MANAGER", "CASHIER", "CLINICIAN", "HR", "AUDITOR"].includes(g.role));
  const home = management ? await managementHome(supabase, today, isOwner, access.user_id, !isOwner && access.grants.some((g) => g.role === "MANAGER" && g.branch_id === null)) : null;
  const staffTodos = management ? null : await staffHome();
  const timeTodo = await timeInTodo();
  if (emp) {
    const { data: myIr } = await supabase.rpc("incident_list");
    const waiting = ((myIr as { reports?: Ir[] } | null)?.reports ?? []).filter((r) => r.mine && r.state === "ISSUED");
    for (const r of waiting) (home?.todos ?? staffTodos)?.unshift({ text: `URGENT: Incident report no. ${r.ir_no} was issued to you. Acknowledge it and write your response`, href: `/incidents/${r.id}`, urgent: true });
  }
  if (timeTodo) (home?.todos ?? staffTodos)?.unshift(timeTodo);
  // Late NTEs waiting for my explanation (shown as boxes at the top), and the owner/GM tardiness tracker.
  const ownerLevel = isOwner || access.grants.some((g) => g.role === "MANAGER" && g.branch_id === null);
  const [{ data: myNteData }, { data: trackData }] = await Promise.all([
    emp ? supabase.from("late_ntes").select("id, nte_no, work_date, shift_start, time_in, late_minutes").eq("employee_id", emp.id).eq("state", "OPEN").order("work_date")
      : Promise.resolve({ data: [] }),
    ownerLevel ? supabase.rpc("late_nte_list", { p_month: `${today.slice(0, 7)}-01`, p_employee: null }) : Promise.resolve({ data: null }),
  ]);
  const myNtes = (myNteData ?? []) as { id: string; nte_no: number; work_date: string; shift_start: string; time_in: string; late_minutes: number }[];
  const tardy = trackData ? tracker((trackData as NteList).ntes, (trackData as NteList).ir_minutes) : [];
  if (missingTodo && !isOwner) (home?.todos ?? staffTodos)?.push(missingTodo);
  if (home && !isOwner && detailState !== "APPROVED" && detailState !== "PENDING") {
    home.todos.push({ text: detailState === "RETURNED" ? "The owner sent your employee details back. Please fix them" : "Fill in your employee details (needed for payroll and government reports)", href: "/me/details" });
  }

  /** Scheduled today and not timed in yet: remind them to time in. */
  async function timeInTodo(): Promise<Todo | null> {
    if (!emp) return null;
    const [{ data: sh }, { count: ins, error }] = await Promise.all([
      supabase.from("shifts").select("is_off, start_time").eq("employee_id", emp.id).eq("work_date", today).eq("state", "PUBLISHED").maybeSingle(),
      supabase.from("time_punches").select("id", { count: "exact", head: true }).eq("employee_id", emp.id).eq("work_date", today).eq("kind", "IN"),
    ]);
    if (error || !sh || sh.is_off || ins) return null;
    return { text: `Time in when you arrive. Your shift today starts at ${timeLabel(sh.start_time)}`, href: "/time", urgent: true };
  }

  /** Staff Home to-dos: unfinished employee details, service entries sent back, commission waiting for sign-off. */
  async function staffHome(): Promise<Todo[]> {
    const since = addDays(today, -30);
    const who = emp ? `created_by.eq.${access.user_id},performer_id.eq.${emp.id},assistant_id.eq.${emp.id}` : `created_by.eq.${access.user_id}`;
    const [{ data: sentBack }, { count: loggedToday }, { data: signData }] = await Promise.all([
      supabase.from("service_logs").select("id, service_date").eq("state", "REJECTED").gte("service_date", since).or(who).order("service_date", { ascending: false }),
      logger ? supabase.from("service_logs").select("id", { count: "exact", head: true }).eq("service_date", today).eq("created_by", access.user_id) : Promise.resolve({ count: 1 }),
      supabase.rpc("pending_signoffs"),
    ]);
    const todos: Todo[] = [];
    if (detailState === "RETURNED") todos.push({ text: "The owner sent your employee details back. Please fix them", href: "/me/details", urgent: true });
    else if (detailState !== "APPROVED" && detailState !== "PENDING") todos.push({ text: "Fill in your employee details (needed for payroll and government reports)", href: "/me/details", urgent: true });
    const back = sentBack ?? [];
    if (back.length) todos.push({ text: `${back.length} service log ${back.length === 1 ? "entry was" : "entries were"} sent back by your manager. Check the reason and log ${back.length === 1 ? "it" : "them"} again`, href: `/services?date=${back[0].service_date}`, urgent: true });
    const mine = (signData as Signoffs | null)?.mine;
    if (mine?.count) {
      todos.push({ text: `${mine.count} of your commission ${mine.count === 1 ? "entry is" : "entries are"} not signed yet (oldest ${dayLabel(mine.oldest!)}). Unsigned entries won't be included in this cutoff (closes ${dayLabel(cutoffEnd(today))}), so remind your manager`, href: `/services?date=${mine.oldest}`, urgent: true });
    }
    if (logger && !loggedToday) todos.push({ text: "Nothing logged today yet. Log each service right after it's done", href: "/services" });
    return todos;
  }

  return (
    <>
      <TopBar access={access} />
      <main>
        <h1>Hi, {first}</h1>
        <p className="muted small">{emp?.position ?? (isOwner ? "Owner" : "Staff")}{emp && ` · ${branchName[emp.branch_id]}`} · {dayLabel(today)}</p>

        {myNtes.length > 0 && (
          <div className="card nte-urgent">
            <h2>Late NTE: please explain<span className="nav-badge inline">{myNtes.length}</span></h2>
            {myNtes.map((n) => (
              <div key={n.id} className="nte-box">
                <p className="small" style={{ margin: 0 }}><strong>NTE no. {n.nte_no} · {dayLabel(n.work_date)}</strong>: your shift started {timeLabel(n.shift_start)} and you timed in{" "}
                  {new Date(n.time_in).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Manila" })} ({n.late_minutes} minutes late).</p>
                <NteExplainForm id={n.id} prompt={`Why were you late, ${first}?`} />
              </div>
            ))}
          </div>
        )}
        {staffTodos && <TodoCard todos={staffTodos} />}
        {home && <ManagerHome g={home.g} todos={home.todos} duty={home.duty} branches={branches.filter((b) => b.kind === "CLINIC").map((b) => ({ id: b.id, name: branchShort(b.name) }))} />}
        {ownerLevel && trackData != null && (
          <div className="card">
            <div className="card-head"><h2>Tardiness tracker, {monthLabel(today.slice(0, 7))}</h2><Link className="small" href="/nte">All Late NTEs</Link></div>
            {tardy.length === 0 ? <p className="muted" style={{ margin: 0 }}>No Late NTEs this month.</p> : (
              <ul className="plain-list">
                {tardy.slice(0, 8).map((r) => (
                  <li key={r.employee_id} className={r.due ? "ir-due" : undefined}>
                    <span><strong>{firstName(r.name)}</strong><Uid v={r.uid} /> has been issued Late NTEs <strong>{times(r.count)}</strong> this month
                      {r.open > 0 && <span className="small muted"> · {r.open} not explained yet</span>}
                      {r.due && <><br /><span className="small ir-due-tag">IR suggested: {r.due}</span></>}</span>
                    <Link className="button secondary small" href={`/nte/staff/${r.employee_id}`}>Open</Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {notices.length > 0 && (
          <div className="card">
            <div className="card-head">
              <h2>Notices{unread > 0 && <span className="nav-badge inline">{unread}</span>}</h2>
              {unread > 0 && <form action={markNoticesRead}><button type="submit" className="secondary small">Mark all read</button></form>}
            </div>
            <ul className="plain-list notices">
              {notices.map((n) => (
                <li key={n.id} className={n.read_at ? "read" : "unread"}>
                  <span>
                    <strong>{n.title}</strong> <span className="small muted">· {when(n.created_at)}</span><br />
                    <span className="small">{n.body}</span>
                  </span>
                  {n.link && <Link className="small" href={noticeHref(n.link, n.body, branches) ?? n.link}>{noticeButton(n.kind)}</Link>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {emp?.commission_eligible && (
          <>
            <div className="grid">
              <div className="card stat hero">
                <Reveal label={`Approved commission, ${monthLabel(ym)}`} note="Signed off by your manager. This is what goes to payroll.">{centsToPhp(approved)}</Reveal>
              </div>
              <div className="card stat">
                <Reveal label="Waiting sign-off" note="Counts once your manager approves it.">{centsToPhp(waiting)}</Reveal>
              </div>
            </div>
            <p className="small muted">Only you and management can see your commission. Figures stay covered until you tap them.</p>
            {recent.length > 0 && (
              <div className="card">
                <h2>Latest this month</h2>
                <ul className="plain-list">
                  {recent.map((l, i) => (
                    <li key={i}>
                      <span>{l.service_logs.service_date.slice(5).replace("-", "/")} · {l.service_logs.services?.name}</span>
                      <span className={`tag ${l.role}`}>{ROLE_TEXT[l.role]}</span>
                      {l.service_logs.state === "PENDING" && <span className="pill STAGED">Waiting</span>}
                    </li>
                  ))}
                </ul>
                <Link href={`/people/${emp.id}`}>See every line and past months →</Link>
              </div>
            )}
          </>
        )}

        <details className="card my-details" open={!management}>
          <summary><h2>My details</h2></summary>
          <dl className="kv" style={{ borderTop: 0, paddingTop: 0 }}>
            <dt>Name</dt><dd>{emp?.full_name ?? access.display_name}</dd>
            <dt>Position</dt><dd>{emp?.position ?? (isOwner ? "Owner" : "Not set yet")}</dd>
            <dt>Home branch</dt><dd>{emp ? branchName[emp.branch_id] : isOwner ? "All branches" : "Not set yet"}</dd>
            <dt>Commission</dt><dd>{emp ? (emp.commission_eligible ? "Yes, 5% of amount paid" : "No") : isOwner ? "No" : "Not set yet"}</dd>
            <dt>App access</dt><dd>{scope.join("; ") || "None yet"}</dd>
            <dt>Login email</dt><dd>{user?.email ?? ""}</dd>
            <dt>UID</dt><dd>{emp?.uid ? <>Staff record <code className="uid" style={{ marginLeft: 0 }}>{emp.uid}</code> · </> : ""}Login account <code className="uid" style={{ marginLeft: 0 }}>{user?.uid ?? ""}</code></dd>
            <dt>Salary payout</dt><dd>Paid in cash by default. Bank accounts are for records only.</dd>
            {user?.joined_at && <><dt>Joined the app</dt><dd>{user.joined_at.slice(0, 10)}</dd></>}
          </dl>
          <p className="small muted" style={{ marginBottom: 0 }}>
            <Link href="/me/details">My employee details</Link>{detailState === "PENDING" ? " (waiting for approval)" : detailState === "APPROVED" ? " (approved)" : ""}.
            Something else wrong? Tell your manager or the owner.
          </p>
        </details>

        {logger && (
          <div className="card">
            <h2>Quick links</h2>
            <Link className="button" href="/services">Open the service log</Link>
          </div>
        )}
      </main>
    </>
  );
}
