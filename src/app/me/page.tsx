import Link from "next/link";
import { HermosappCard } from "@/components/Hermosapp";
import { can, requireAccess } from "@/lib/access";
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
import { loadFaces } from "@/lib/dutyFaces";
import { noticeButton, noticeHref } from "@/lib/noticeLink";
import { computeGlance, cutoffEnd, dayLabel, glanceFetchStart, type StatusDay } from "@/lib/homeGlance";
import { addDays, sortBranches } from "@/lib/insights";
import { missingRequired, type Details } from "@/lib/employeeDetails";
import { tracker, type NteList } from "@/lib/nte";
import { NteDeadline, NteExplainForm } from "../nte/Forms";
import { HomeBookings, loadHomeBookings } from "./HomeBookings";
import { HomeTardiness } from "./HomeTardiness";

type Signoffs = { to_sign: { count: number; oldest: string | null }; mine: { count: number; oldest: string | null } };
type DailyStatus = { ok: boolean; branches?: { id: string; code: string; name: string }[]; days?: StatusDay[];
  corrections?: { id: string; mine: boolean }[] };

/** The management Home: today's and yesterday's sales, the month, and who's on duty. To-dos live in the bell (src/lib/todos.ts). */
async function managementHome(supabase: Awaited<ReturnType<typeof requireAccess>>["supabase"], today: string) {
  const [{ data: st }, { data: dutyData }, bookings] = await Promise.all([
    supabase.rpc("daily_sales_status", { p_start: glanceFetchStart(today), p_end: today }),
    supabase.rpc("on_duty", { p_date: today }), // errors (before update-0022) mean no On Duty card
    loadHomeBookings(supabase, today, true), // CHRIS Nov 26: today's bookings at every branch, live on Home
  ]);
  const s = (st ?? { ok: false }) as DailyStatus;
  if (!s.ok) return null;
  const g = computeGlance(today, sortBranches(s.branches ?? []), s.days ?? []);
  const duty = Array.isArray(dutyData) ? (dutyData as DutyRow[]) : null;
  const faces = duty?.length ? await loadFaces(supabase, duty) : {};
  return { g, duty, faces, bookings };
}

type Notice = { id: string; kind?: string; title: string; body: string | null; link: string | null; created_at: string; read_at: string | null };
const when = (iso: string) => new Date(iso).toLocaleString("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

const ROLE_LABEL: Record<string, string> = {
  OWNER: "Owner", FINANCE: "Finance", MANAGER: "Manager", CASHIER: "Front desk", HR: "HR",
  MARKETING: "Marketing", CLINICIAN: "Clinician", INVENTORY: "Inventory", AUDITOR: "Auditor",
};

type Line = { role: string; amount_cents: number; service_logs: { service_date: string; state: string; photos_due?: boolean; services: { name: string } | null } };

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
    ? await supabase.from("commission_lines").select("role, amount_cents, service_logs!inner(service_date, state, photos_due, services(name))")
        .eq("employee_id", emp.id).gte("service_logs.service_date", start).lte("service_logs.service_date", monthEnd(start))
    : { data: [] };
  const lines = (data ?? []) as unknown as Line[];
  // update-0054: entries still missing client photos don't count until they're added.
  const sum = (state: string) => lines.filter((l) => l.service_logs.state === state && !l.service_logs.photos_due).reduce((s, l) => s + Number(l.amount_cents), 0);
  const approved = sum("APPROVED"), waiting = sum("PENDING");
  // Commission earned today, approved or still waiting (CHRIS Nov 26). Today's lines are in this month's list.
  const todayIso = manilaToday();
  const todayCents = lines.filter((l) => l.service_logs.service_date === todayIso && l.service_logs.state !== "REJECTED").reduce((s, l) => s + Number(l.amount_cents), 0);
  const showToday = todayIso >= start && todayIso <= monthEnd(start);
  const held = lines.filter((l) => l.service_logs.state !== "REJECTED" && l.service_logs.photos_due).reduce((s, l) => s + Number(l.amount_cents), 0);
  const recent = lines.filter((l) => l.service_logs.state !== "REJECTED")
    .sort((a, b) => b.service_logs.service_date.localeCompare(a.service_logs.service_date)).slice(0, 5);
  const branchName = Object.fromEntries(branches.map((b) => [b.id, b.name]));
  const scope = access.grants.map((g) => `${ROLE_LABEL[g.role] ?? g.role}, ${g.branch_id ? branchName[g.branch_id] ?? "branch" : "all branches"}`);
  const isOwner = access.grants.some((g) => g.role === "OWNER");
  const first = (emp?.full_name || access.display_name).trim().split(/\s+/)[0];
  const management = access.grants.some((g) => ["OWNER", "FINANCE", "MANAGER", "AUDITOR"].includes(g.role));
  const logger = access.grants.some((g) => ["OWNER", "FINANCE", "MANAGER", "CASHIER", "CLINICIAN", "HR", "AUDITOR"].includes(g.role));
  const home = management ? await managementHome(supabase, today) : null;
  // CHRIS Nov 26: every employee's Home has the live Bookings board (management gets it inside ManagerHome).
  const staffBookings = management ? null : await loadHomeBookings(supabase, today, can(access, ["CSR", "OWNER", "MANAGER"], null));
  // Late NTEs waiting for my explanation (shown as boxes at the top), and the owner/GM tardiness tracker.
  const ownerLevel = isOwner || access.grants.some((g) => g.role === "MANAGER" && g.branch_id === null);
  await supabase.rpc("run_nte_deadlines"); // issues the automatic IRs that are due (errors before update-0032 are ignored)
  const [{ data: myNteData }, { data: trackData }] = await Promise.all([
    emp ? supabase.from("late_ntes").select("id, nte_no, work_date, shift_start, time_in, late_minutes, respond_by, ir_id").eq("employee_id", emp.id).eq("state", "OPEN").order("work_date")
      : Promise.resolve({ data: [] }),
    ownerLevel ? supabase.rpc("late_nte_list", { p_month: `${today.slice(0, 7)}-01`, p_employee: null }) : Promise.resolve({ data: null }),
  ]);
  const myNtes = (myNteData ?? []) as { id: string; nte_no: number; work_date: string; shift_start: string; time_in: string; late_minutes: number; respond_by?: string | null; ir_id?: string | null }[];
  // Team chat on Home (update-0049+, CHRIS Nov 26): messages from management stand out; other unread messages are counted.
  const [{ data: mgmtChat }, { data: chatUnread }] = await Promise.all([
    ownerLevel ? Promise.resolve({ data: [] }) : supabase.rpc("chat_mgmt_unread"),
    supabase.rpc("chat_unread"),
  ]);
  const fromMgmt = Array.isArray(mgmtChat) ? (mgmtChat as { id: string; room_id: string; sender: string; room_name: string | null; text: string }[]) : [];
  const otherUnread = Math.max(0, (typeof chatUnread === "number" ? chatUnread : 0) - fromMgmt.length);
  // Client photos and waivers I still owe (update-0054): always urgent on Home.
  const { data: dueData } = emp ? await supabase.rpc("my_photos_due") : { data: null };
  const photosDue = (Array.isArray(dueData) ? dueData : []) as { id: string; date: string; client: string | null; service: string | null; branch: string; amount: number }[];
  const homeBranches = branches.filter((b) => b.kind === "CLINIC" || b.kind === "WFH").map((b) => ({ id: b.id, name: branchShort(b.name), code: b.code }));
  const tardy = trackData ? tracker((trackData as NteList).ntes, (trackData as NteList).ir_minutes) : [];

  return (
    <>
      <TopBar access={access} />
      <main>
        <h1>Hi, {first}</h1>
        <p className="muted small">{emp?.position ?? (isOwner ? "Owner" : "Staff")}{emp && ` · ${branchName[emp.branch_id]}`} · {dayLabel(today)}</p>

        <HermosappCard />
        {photosDue.length > 0 && (
          <div className="card nte-urgent">
            <h2>Urgent: add client photos and waiver<span className="nav-badge inline">{photosDue.length}</span></h2>
            <p className="small" style={{ margin: 0 }}>Incomplete files: your commission for these entries won&apos;t count toward your totals until the before and after photos and both waiver pages are added.</p>
            {photosDue.map((d) => (
              <div key={d.id} className="nte-box">
                <p className="small" style={{ margin: 0 }}><strong>{d.client ?? "Client"} · {d.service ?? "Service"}</strong> · {dayLabel(d.date)}</p>
                <Link className="button small" href={`/services?date=${d.date}&branch=${d.branch}&entry=${d.id}#entry-${d.id}`}>Add photos</Link>
              </div>
            ))}
          </div>
        )}
        {myNtes.length > 0 && (
          <div className="card nte-urgent">
            <h2>Late NTE: please explain<span className="nav-badge inline">{myNtes.length}</span></h2>
            {myNtes.map((n) => (
              <div key={n.id} className="nte-box">
                <p className="small" style={{ margin: 0 }}><strong>NTE no. {n.nte_no} · {dayLabel(n.work_date)}</strong>: your shift started {timeLabel(n.shift_start)} and you timed in{" "}
                  {new Date(n.time_in).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Manila" })} ({n.late_minutes} minutes late).</p>
                <NteDeadline n={n} />
                <NteExplainForm id={n.id} prompt={`Why were you late, ${first}?`} />
              </div>
            ))}
          </div>
        )}
        {fromMgmt.length > 0 && (
          <div className="card chat-home-mgmt">
            <span className="mgmt-alert-tag"><span aria-hidden>📣</span> Message from management</span>
            {fromMgmt.slice(0, 3).map((m) => (
              <Link key={m.id} href={`/chat/${m.room_id}`} className="chat-home-line">
                <strong>{m.sender}{m.room_name ? ` in ${m.room_name}` : ""}</strong>
                <span>{m.text}</span>
              </Link>
            ))}
            <Link className="button" href={`/chat/${fromMgmt[0].room_id}`}>Open and reply</Link>
          </div>
        )}
        {otherUnread > 0 && (
          <div className="card chat-home">
            <span><strong>{otherUnread} unread chat {otherUnread === 1 ? "message" : "messages"}</strong></span>
            <a className="button secondary small" href="/chat">Open Chat</a>
          </div>
        )}
        {staffBookings && <HomeBookings rows={staffBookings.rows} who={staffBookings.who} toFollow={staffBookings.toFollow}
          branches={sortBranches(branches.filter((b) => b.kind === "CLINIC")).map((b) => ({ id: b.id, name: branchShort(b.name), code: b.code }))} />}
        {home && <ManagerHome me={access.user_id} g={home.g} duty={home.duty} faces={home.faces} branches={homeBranches}
          bookings={home.bookings && <HomeBookings rows={home.bookings.rows} who={home.bookings.who} toFollow={home.bookings.toFollow} branches={home.g.branches.map((x) => homeBranches.find((b) => b.id === x.id) ?? { id: x.id, name: x.name })} />}
          tardiness={ownerLevel && trackData != null && <HomeTardiness month={monthLabel(today.slice(0, 7))} ntes={(trackData as NteList).ntes} people={tardy} />} />}
        {emp?.commission_eligible && (
          <>
            <div className="grid">
              <div className="card stat hero">
                <Reveal label={`Approved commission, ${monthLabel(ym)}`} note="Signed off by your manager. This is what goes to payroll.">{centsToPhp(approved)}</Reveal>
              </div>
              {showToday && (
                <div className="card stat">
                  <Reveal label="Commission today" note="Today's entries, approved or waiting sign-off.">{centsToPhp(todayCents)}</Reveal>
                </div>
              )}
              <div className="card stat">
                <Reveal label="Waiting sign-off" note="Counts once your manager approves it.">{centsToPhp(waiting)}</Reveal>
              </div>
              {held > 0 && (
                <div className="card stat">
                  <Reveal label="Held: photos missing" note="Counts once the client photos and waiver are added.">{centsToPhp(held)}</Reveal>
                </div>
              )}
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
            <dt>Profile picture</dt><dd><Link href="/me/photo">Add or change your picture</Link></dd>
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
