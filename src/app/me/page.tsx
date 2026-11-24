import Link from "next/link";
import { requireAccess } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { Reveal } from "@/components/Reveal";
import { centsToPhp } from "@/lib/csv";
import { manilaToday } from "@/lib/dates";
import { monthEnd, monthLabel, monthStart } from "@/lib/insights";
import { ROLE_TEXT } from "@/lib/commission";
import { markNoticesRead } from "./actions";
import { ManagerHome, type Todo } from "./ManagerHome";
import { computeGlance, dayLabel, glanceFetchStart, type StatusDay } from "@/lib/homeGlance";
import { sortBranches } from "@/lib/insights";

type DailyStatus = { ok: boolean; branches?: { id: string; code: string; name: string }[]; days?: StatusDay[];
  corrections?: { id: string; mine: boolean }[] };

/** Everything the management Home needs, in one round of queries. Missing pieces (older database) just drop out. */
async function managementHome(supabase: Awaited<ReturnType<typeof requireAccess>>["supabase"], today: string, owner: boolean) {
  const [{ data: st }, { data: overdueData }, { count: logsWaiting }, { count: uploads }, { count: details }, { count: joins }] = await Promise.all([
    supabase.rpc("daily_sales_status", { p_start: glanceFetchStart(today), p_end: today }),
    supabase.rpc("overdue_commission_days"),
    supabase.from("service_logs").select("id", { count: "exact", head: true }).eq("state", "PENDING"),
    supabase.from("import_batches").select("id", { count: "exact", head: true }).eq("state", "STAGED"),
    owner ? supabase.from("employee_detail_submissions").select("id", { count: "exact", head: true }).eq("state", "PENDING") : Promise.resolve({ count: 0 }),
    owner ? supabase.from("app_users").select("id", { count: "exact", head: true }).eq("join_status", "PENDING") : Promise.resolve({ count: 0 }),
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
  else if (logsWaiting) todos.push({ text: `${plural(logsWaiting, "service log entry is", "service log entries are")} waiting for sign-off`, href: "/services" });
  if (uploads) todos.push({ text: `${plural(uploads, "upload is", "uploads are")} waiting for sign-off`, href: "/imports" });
  if (details) todos.push({ text: `${plural(details, "staff member sent", "staff members sent")} employee details to review`, href: "/admin/details" });
  if (joins) todos.push({ text: `${plural(joins, "person is", "people are")} asking to join the app`, href: "/admin/users" });
  return { g, todos };
}

type Notice = { id: string; title: string; body: string | null; link: string | null; created_at: string; read_at: string | null };
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
    supabase.from("employees").select("id, full_name, branch_id, position, commission_eligible, active").eq("app_user_id", access.user_id).maybeSingle(),
    supabase.from("app_users").select("email, joined_at").eq("id", access.user_id).maybeSingle(),
    supabase.from("employee_detail_submissions").select("state, note").eq("user_id", access.user_id).neq("state", "SUPERSEDED")
      .order("submitted_at", { ascending: false }).limit(1),
    supabase.from("notifications").select("id, title, body, link, created_at, read_at").order("created_at", { ascending: false }).limit(15),
  ]);
  const notices = (noticeData ?? []) as Notice[];
  const unread = notices.filter((n) => !n.read_at).length;
  const detailState = subs?.[0]?.state as string | undefined;
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
  const home = management ? await managementHome(supabase, today, isOwner) : null;
  const logger = access.grants.some((g) => ["OWNER", "FINANCE", "MANAGER", "CASHIER", "CLINICIAN", "HR", "AUDITOR"].includes(g.role));

  return (
    <>
      <TopBar access={access} />
      <main>
        <h1>Hi, {first}</h1>
        <p className="muted small">{emp?.position ?? (isOwner ? "Owner" : "Staff")}{emp && ` · ${branchName[emp.branch_id]}`} · {dayLabel(today)}</p>

        {!isOwner && detailState !== "APPROVED" && detailState !== "PENDING" && (
          <div className={`notice ${detailState === "RETURNED" ? "error" : "info"}`}>
            {detailState === "RETURNED" ? "The owner sent your employee details back to fix. " : "Please fill in your employee details for payroll and government reports. "}
            <Link href="/me/details">{detailState === "RETURNED" ? "Fix my details" : "Fill them in"}</Link>
          </div>
        )}
        {home && <ManagerHome g={home.g} todos={home.todos} />}
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
                  {n.link && <Link className="small" href={n.link}>Open</Link>}
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
