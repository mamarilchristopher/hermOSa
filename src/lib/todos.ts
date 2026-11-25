import type { SupabaseClient } from "@supabase/supabase-js";
import type { Access } from "./access";
import type { Ir } from "./incidents";
import { computeGlance, cutoffEnd, dayLabel, glanceFetchStart, type StatusDay } from "./homeGlance";
import { addDays, sortBranches } from "./insights";
import { missingRequired, type Details } from "./employeeDetails";
import { timeLabel } from "./schedule";

/** One to-do in the notification bell (CHRIS Nov 25: like Facebook notifications, every item opens its page). */
export type Todo = { text: string; href: string; urgent?: boolean };

type Signoffs = { to_sign: { count: number; oldest: string | null }; mine: { count: number; oldest: string | null } };
type DailyStatus = { ok: boolean; branches?: { id: string; code: string; name: string }[]; days?: StatusDay[]; corrections?: { id: string; mine: boolean }[] };
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Everything waiting on this person, most urgent first. Missing pieces (older database) just drop out. */
export async function loadTodos(supabase: SupabaseClient, access: Access, today: string): Promise<Todo[]> {
  const isOwner = access.grants.some((g) => g.role === "OWNER");
  const gm = !isOwner && access.grants.some((g) => g.role === "MANAGER" && g.branch_id === null);
  const ownerLevel = isOwner || gm;
  const management = access.grants.some((g) => ["OWNER", "FINANCE", "MANAGER", "AUDITOR"].includes(g.role));
  const logger = access.grants.some((g) => ["OWNER", "FINANCE", "MANAGER", "CASHIER", "CLINICIAN", "HR", "AUDITOR"].includes(g.role));
  const userId = access.user_id;

  const [{ data: emp }, { data: subs }] = await Promise.all([
    supabase.from("employees").select("id").eq("app_user_id", userId).eq("active", true).order("created_at").limit(1).maybeSingle(),
    supabase.from("employee_detail_submissions").select("state, data").eq("user_id", userId).neq("state", "SUPERSEDED").order("submitted_at", { ascending: false }).limit(1),
  ]);
  const detailState = subs?.[0]?.state as string | undefined;
  const missing = detailState === "APPROVED" || detailState === "PENDING" ? missingRequired((subs?.[0]?.data ?? {}) as Details) : [];

  const todos: Todo[] = management ? await managementTodos() : await staffTodos();

  // Personal items, for everyone with an employee record.
  if (emp) {
    const { data: myIr } = await supabase.rpc("incident_list");
    const waiting = ((myIr as { reports?: Ir[] } | null)?.reports ?? []).filter((r) => r.mine && r.state === "ISSUED");
    for (const r of waiting) todos.unshift({ text: `URGENT: Incident report no. ${r.ir_no} was issued to you. Acknowledge it and write your response`, href: `/incidents/${r.id}`, urgent: true });
    const { data: ntes } = await supabase.from("late_ntes").select("id, work_date").eq("employee_id", emp.id).eq("state", "OPEN").order("work_date");
    for (const n of (ntes ?? []) as { work_date: string }[]) todos.unshift({ text: `Late NTE for ${dayLabel(n.work_date)}: please explain why you were late`, href: "/me", urgent: true });
    const timeTodo = await timeIn(emp.id);
    if (timeTodo) todos.unshift(timeTodo);
  }
  if (missing.length && !isOwner) {
    todos.push({ text: `Your employee details need ${missing.length <= 3 ? missing.map((f) => f.label.replace(/\s*\(.*\)/, "")).join(", ") : `${missing.length} more items`}. Please add them`, href: "/me/details" });
  }
  // Profile pictures (update-0034).
  const [{ data: myPhotoRow, error: photoErr }, { count: photosWaiting }] = await Promise.all([
    supabase.from("profile_photos").select("state, note").eq("user_id", userId).neq("state", "SUPERSEDED").order("submitted_at", { ascending: false }).limit(1).maybeSingle(),
    ownerLevel ? supabase.from("profile_photos").select("id", { count: "exact", head: true }).eq("state", "PENDING").neq("user_id", isOwner ? "00000000-0000-0000-0000-000000000000" : userId) : Promise.resolve({ count: 0 }),
  ]);
  if (!photoErr) {
    if (!myPhotoRow) todos.push({ text: "Add your profile picture (an owner approves it)", href: "/me/photo" });
    else if (myPhotoRow.state === "RETURNED") todos.push({ text: `Your profile picture was sent back${myPhotoRow.note ? `: ${myPhotoRow.note}` : ""}. Please upload another`, href: "/me/photo", urgent: true });
    if (photosWaiting) todos.push({ text: `${plural(photosWaiting, "profile picture is", "profile pictures are")} waiting for your approval`, href: "/admin/photos" });
  }
  // Leave (update-0035) and swaps (update-0036).
  const [{ count: leaveWaiting, error: leaveErr }, { data: myLeave }, { count: swapAsks }] = await Promise.all([
    ownerLevel ? supabase.from("leave_requests").select("id", { count: "exact", head: true }).eq("state", "PENDING").neq("filed_by", isOwner ? "00000000-0000-0000-0000-000000000000" : userId) : Promise.resolve({ count: 0, error: null }),
    emp ? supabase.from("leave_requests").select("kind, start_date").eq("employee_id", emp.id).eq("state", "DECLINED").gte("decided_at", new Date(Date.now() - 3 * 86400000).toISOString()).limit(3) : Promise.resolve({ data: [] }),
    emp ? supabase.from("schedule_requests").select("id", { count: "exact", head: true }).eq("other_employee_id", emp.id).eq("state", "PENDING").eq("coworker_state", "WAITING") : Promise.resolve({ count: 0 }),
  ]);
  if (swapAsks) todos.unshift({ text: `${swapAsks === 1 ? "A coworker asked" : `${swapAsks} coworkers asked`} to swap schedules with you. Accept or decline`, href: "/schedule", urgent: true });
  if (!leaveErr && leaveWaiting) todos.unshift({ text: `${plural(leaveWaiting, "leave request is", "leave requests are")} waiting for your approval`, href: "/leave" });
  for (const l of (myLeave ?? []) as { kind: string; start_date: string }[]) todos.push({ text: `Your ${l.kind} from ${l.start_date} was not approved. See the note`, href: "/leave" });
  // Bookings (update-0040): CSRs confirm tomorrow's visits; branch staff see today's online bookings.
  const csr = access.grants.some((g) => g.role === "CSR");
  const branchStaff = access.grants.some((g) => ["MANAGER", "CLINICIAN", "CASHIER"].includes(g.role) && g.branch_id !== null);
  if (csr || branchStaff) {
    const tomorrow = addDays(today, 1);
    const [{ count: toConfirm, error: bErr }, { count: todayVisits }] = await Promise.all([
      csr ? supabase.from("bookings").select("id", { count: "exact", head: true }).eq("appointment_date", tomorrow).eq("status", "BOOKED") : Promise.resolve({ count: 0, error: null }),
      branchStaff ? supabase.from("bookings").select("id", { count: "exact", head: true }).eq("appointment_date", today).in("status", ["BOOKED", "CONFIRMED"]) : Promise.resolve({ count: 0 }),
    ]);
    if (!bErr && toConfirm) todos.unshift({ text: `${toConfirm} visit${toConfirm === 1 ? "" : "s"} tomorrow still to confirm. Message them and mark Confirmed`, href: `/bookings?d=${tomorrow}`, urgent: true });
    if (todayVisits) todos.push({ text: `${todayVisits} online booking${todayVisits === 1 ? "" : "s"} today not marked yet. Tap Arrived when they come in`, href: "/bookings" });
  }
  if (management && !isOwner && detailState !== "APPROVED" && detailState !== "PENDING") {
    todos.push({ text: detailState === "RETURNED" ? "The owner sent your employee details back. Please fix them" : "Fill in your employee details (needed for payroll and government reports)", href: "/me/details" });
  }
  // Urgent first, keeping each group's order.
  // Team chat (update-0049+): unread messages from management come first and are urgent; then other unread messages.
  const [{ data: mgmtChat }, { data: chatUnread }] = await Promise.all([
    ownerLevel ? Promise.resolve({ data: [] }) : supabase.rpc("chat_mgmt_unread"),
    supabase.rpc("chat_unread"),
  ]);
  const fromMgmt = Array.isArray(mgmtChat) ? (mgmtChat as { room_id: string; sender: string }[]) : [];
  if (fromMgmt.length) todos.unshift({ text: `📣 ${plural(fromMgmt.length, "message", "messages")} from management (${fromMgmt[0].sender}). Open Chat and read ${fromMgmt.length === 1 ? "it" : "them"}`, href: `/chat/${fromMgmt[0].room_id}`, urgent: true });
  const others = (typeof chatUnread === "number" ? chatUnread : 0) - fromMgmt.length;
  if (others > 0) todos.push({ text: `${plural(others, "unread chat message", "unread chat messages")}`, href: "/chat" });
  return [...todos.filter((t) => t.urgent), ...todos.filter((t) => !t.urgent)];

  async function timeIn(empId: string): Promise<Todo | null> {
    const [{ data: sh }, { count: ins, error }] = await Promise.all([
      supabase.from("shifts").select("is_off, start_time").eq("employee_id", empId).eq("work_date", today).eq("state", "PUBLISHED").maybeSingle(),
      supabase.from("time_punches").select("id", { count: "exact", head: true }).eq("employee_id", empId).eq("work_date", today).eq("kind", "IN"),
    ]);
    if (error || !sh || sh.is_off || ins) return null;
    return { text: `Time in when you arrive. Your shift today starts at ${timeLabel(sh.start_time)}`, href: "/time", urgent: true };
  }

  async function managementTodos(): Promise<Todo[]> {
    const [{ data: st }, { data: overdueData }, { data: signData }, { count: uploads }, { count: details }, { count: joins }, { data: dutyData }, { count: schedReqs }, { data: irData }] = await Promise.all([
      supabase.rpc("daily_sales_status", { p_start: glanceFetchStart(today), p_end: today }),
      supabase.rpc("overdue_commission_days"),
      supabase.rpc("pending_signoffs"),
      supabase.from("import_batches").select("id", { count: "exact", head: true }).eq("state", "STAGED"),
      ownerLevel ? supabase.from("employee_detail_submissions").select("id", { count: "exact", head: true }).eq("state", "PENDING").neq("user_id", userId) : Promise.resolve({ count: 0 }),
      supabase.from("app_users").select("id", { count: "exact", head: true }).eq("join_status", "PENDING"),
      supabase.rpc("on_duty", { p_date: today }),
      supabase.from("schedule_requests").select("id", { count: "exact", head: true }).eq("state", "PENDING").neq("requested_by", userId).or("kind.eq.DAY_OFF,coworker_state.eq.ACCEPTED"),
      supabase.rpc("incident_list"),
    ]);
    const todos: Todo[] = [];
    const s = (st ?? { ok: false }) as DailyStatus;
    if (s.ok) {
      const g = computeGlance(today, sortBranches(s.branches ?? []), s.days ?? []);
      if (g.yesterdayMissing.length) todos.push({ text: `Yesterday's sales not entered yet: ${g.yesterdayMissing.join(", ")}`, href: "/sales/daily", urgent: true });
      const olderEmpty = g.emptyDays - g.yesterdayMissing.length;
      if (olderEmpty > 0) todos.push({ text: `${plural(olderEmpty, "earlier day", "earlier days")} this month with nothing entered (enter the total or mark Zero sales / Closed)`, href: "/sales/missing" });
      const changes = (s.corrections ?? []).filter((c) => !c.mine).length;
      if (changes) todos.push({ text: `${plural(changes, "sales change needs", "sales changes need")} a second person to confirm`, href: "/sales/daily", urgent: true });
    }
    const overdue = (Array.isArray(overdueData) ? overdueData : []) as { name: string; date: string; code?: string }[];
    if (overdue.length) todos.push({ text: `Commission sign-off overdue: ${overdue.slice(0, 4).map((o) => `${o.name.replace(/ \(.*\)$/, "")} ${dayLabel(o.date).slice(5)}`).join(", ")}${overdue.length > 4 ? ", and more" : ""}`, href: `/services?date=${overdue[0].date}${overdue[0].code ? `&branch=${overdue[0].code}` : ""}`, urgent: true });
    const toSign = (signData as Signoffs | null)?.to_sign;
    if (toSign?.count) todos.push({
      text: `Sign off ${plural(toSign.count, "commission entry", "commission entries")} (oldest ${dayLabel(toSign.oldest!)}). Anything unsigned by ${dayLabel(cutoffEnd(today))} isn't paid in this cutoff`,
      href: `/services?date=${toSign.oldest}`, urgent: !overdue.length });
    if (uploads) todos.push({ text: `${plural(uploads, "upload is", "uploads are")} waiting for sign-off`, href: "/imports" });
    if (details) todos.push({ text: `${plural(details, "staff member sent", "staff members sent")} employee details to review`, href: "/admin/details" });
    if (joins) todos.push({ text: `${plural(joins, "person is", "people are")} asking to join the app`, href: isOwner ? "/admin/users" : "/admin/joins" });
    if (schedReqs) todos.push({ text: `${plural(schedReqs, "schedule change is", "schedule changes are")} waiting for approval (swaps or day-off moves)`, href: "/schedule" });
    const irs = ((irData as { reports?: Ir[] } | null)?.reports ?? []).filter((r) => r.can_manage);
    const irDraft = irs.filter((r) => r.state === "DRAFT").length, irExplained = irs.filter((r) => r.state === "EXPLAINED").length;
    if (irDraft) todos.push({ text: `${plural(irDraft, "tardiness IR is", "tardiness IRs are")} ready to review and issue`, href: "/incidents", urgent: true });
    if (irExplained) todos.push({ text: `${plural(irExplained, "IR has", "IRs have")} an explanation. Close with the action taken`, href: "/incidents" });
    if (Array.isArray(dutyData)) {
      const hm = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Manila" });
      const notIn = (dutyData as { off: boolean; start: string | null; time_in: string | null; name: string }[]).filter((r) => !r.off && r.start && !r.time_in && r.start.slice(0, 5) <= hm);
      if (notIn.length) todos.push({ text: `Not timed in yet: ${notIn.slice(0, 5).map((r) => r.name.split(" ")[0]).join(", ")}${notIn.length > 5 ? ", and more" : ""}`, href: "/time", urgent: true });
    }
    return todos;
  }

  async function staffTodos(): Promise<Todo[]> {
    const since = addDays(today, -30);
    const who = emp ? `created_by.eq.${userId},performer_id.eq.${emp.id},assistant_id.eq.${emp.id}` : `created_by.eq.${userId}`;
    const [{ data: sentBack }, { count: loggedToday }, { data: signData }] = await Promise.all([
      supabase.from("service_logs").select("id, service_date").eq("state", "REJECTED").gte("service_date", since).or(who).order("service_date", { ascending: false }),
      logger ? supabase.from("service_logs").select("id", { count: "exact", head: true }).eq("service_date", today).eq("created_by", userId) : Promise.resolve({ count: 1 }),
      supabase.rpc("pending_signoffs"),
    ]);
    const todos: Todo[] = [];
    if (detailState === "RETURNED") todos.push({ text: "The owner sent your employee details back. Please fix them", href: "/me/details", urgent: true });
    else if (detailState !== "APPROVED" && detailState !== "PENDING") todos.push({ text: "Fill in your employee details (needed for payroll and government reports)", href: "/me/details", urgent: true });
    const back = sentBack ?? [];
    if (back.length) todos.push({ text: `${back.length} service log ${back.length === 1 ? "entry was" : "entries were"} sent back by your manager. Check the reason and log ${back.length === 1 ? "it" : "them"} again`, href: `/services?date=${back[0].service_date}`, urgent: true });
    const mine = (signData as Signoffs | null)?.mine;
    if (mine?.count) todos.push({ text: `${mine.count} of your commission ${mine.count === 1 ? "entry is" : "entries are"} not signed yet (oldest ${dayLabel(mine.oldest!)}). Unsigned entries won't be included in this cutoff (closes ${dayLabel(cutoffEnd(today))}), so remind your manager`, href: `/services?date=${mine.oldest}`, urgent: true });
    if (logger && !loggedToday) todos.push({ text: "Nothing logged today yet. Log each service right after it's done", href: "/services" });
    return todos;
  }
}
