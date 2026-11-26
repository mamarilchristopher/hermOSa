import Link from "next/link";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireAccess, errorText } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { centsToPhp } from "@/lib/csv";
import { manilaToday } from "@/lib/dates";
import { cutoffEnd, dayLabel } from "@/lib/homeGlance";
import { TodoCard, type Todo } from "../ManagerHome";
import { StaticMenu } from "@/components/NavLinks";
import { menuFor } from "@/lib/hubs";

type ViewAs = {
  ok: boolean; error?: string; name: string; email: string; joined_at: string | null;
  employee: { id: string; position: string | null; branch_id: string; commission_eligible: boolean } | null;
  roles: { role: string; branch_id: string | null }[];
  details_state: string | null;
  sent_back: { count: number; latest: string | null };
  unsigned: { count: number; oldest: string | null; cents: number };
  month_approved_cents: number; logged_today: number; last_seen: string | null;
};
const ROLE_LABEL: Record<string, string> = {
  OWNER: "Owner", FINANCE: "Finance", MANAGER: "Manager", CASHIER: "Front desk", HR: "HR",
  MARKETING: "Marketing", CLINICIAN: "Clinician", INVENTORY: "Inventory", AUDITOR: "Auditor",
};
const LOGGERS = ["OWNER", "FINANCE", "MANAGER", "CASHIER", "CLINICIAN", "HR", "AUDITOR"];

/** Owners and the general manager: a read-only look at someone's Home and pending work. */
export default async function ViewAsPage({ searchParams }: { searchParams: Promise<{ u?: string }> }) {
  const { supabase, access, branches } = await requireAccess();
  if (!access.grants.some((g) => (g.role === "OWNER" || g.role === "MANAGER") && g.branch_id === null)) redirect("/me");
  const id = z.uuid().safeParse((await searchParams).u);
  if (!id.success) redirect("/me");
  const [{ data }, { data: chatData }, { data: noticeData }] = await Promise.all([
    supabase.rpc("view_as", { p_user: id.data }),
    supabase.rpc("view_as_chat", { p_user: id.data }), // counts only; chats stay private (update-0051)
    supabase.rpc("view_as_notices", { p_user: id.data }), // their bell; chat notices without the message (update-0052)
  ]);
  const notices = (noticeData ?? null) as { ok: boolean; unread: number; latest: { title: string; body: string | null; created_at: string; read: boolean; kind?: string }[] } | null;
  const chat = (chatData ?? null) as { ok: boolean; unread: number; mgmt_unread: number; tagged_unread: number } | null;
  const v = (data ?? { ok: false, error: "UNKNOWN" }) as ViewAs;
  const today = manilaToday();
  const branchName = Object.fromEntries(branches.map((b) => [b.id, b.name]));

  if (!v.ok) {
    return (<><TopBar access={access} /><main><Link href="/me">← Back to my Home</Link><div className="notice error">{v.error === "UNKNOWN" ? "View as isn't set up yet. The owner needs to run update-0021 in Supabase." : errorText(v.error)}</div></main></>);
  }
  const first = v.name.trim().split(/\s+/)[0];
  const todos: Todo[] = [];
  if (v.details_state === "RETURNED") todos.push({ text: "Employee details were sent back to fix", href: "/admin/details", urgent: true });
  else if (v.details_state !== "APPROVED" && v.details_state !== "PENDING") todos.push({ text: "Employee details not filled in yet", href: "/admin/details", urgent: true });
  else if (v.details_state === "PENDING") todos.push({ text: "Employee details sent, waiting for the owner to review", href: "/admin/details" });
  if (v.sent_back.count) todos.push({ text: `${v.sent_back.count} service log ${v.sent_back.count === 1 ? "entry was" : "entries were"} sent back in the last 30 days`, href: `/services?date=${v.sent_back.latest}`, urgent: true });
  if (v.unsigned.count) todos.push({ text: `${v.unsigned.count} commission ${v.unsigned.count === 1 ? "entry" : "entries"} not signed yet (oldest ${dayLabel(v.unsigned.oldest!)}, ${centsToPhp(v.unsigned.cents)}). Not paid in this cutoff (closes ${dayLabel(cutoffEnd(today))}) unless signed`, href: `/services?date=${v.unsigned.oldest}`, urgent: true });
  if (chat?.ok && chat.mgmt_unread) todos.push({ text: `📣 ${chat.mgmt_unread} unread chat ${chat.mgmt_unread === 1 ? "message" : "messages"} from management`, href: "/chat", urgent: true });
  if (chat?.ok && chat.unread - chat.mgmt_unread > 0) todos.push({ text: `${chat.unread - chat.mgmt_unread} other unread chat ${chat.unread - chat.mgmt_unread === 1 ? "message" : "messages"}${chat.tagged_unread ? ` (tagged in ${chat.tagged_unread})` : ""}`, href: "/chat" });
  if (v.roles.some((r) => LOGGERS.includes(r.role)) && !v.logged_today) todos.push({ text: "Nothing logged today yet", href: "/services" });
  const scope = v.roles.map((r) => `${ROLE_LABEL[r.role] ?? r.role}, ${r.branch_id ? branchName[r.branch_id] ?? "branch" : "all branches"}`);
  const seen = v.last_seen ? new Date(v.last_seen).toLocaleString("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : null;

  return (
    <>
      <TopBar access={access} viewing={{ name: v.name, grants: v.roles.map((r) => ({ role: r.role, branch_id: r.branch_id })) }} />
      <main>
        <div className="notice info view-as-bar">
          <span>Viewing <strong>{first}&apos;s</strong> Home. Read only: nothing can be changed here.</span>
          <Link className="button secondary small" href="/me">Back to my Home</Link>
        </div>
        <h1>Hi, {first}</h1>
        <p className="muted small">{v.employee?.position ?? "Staff"}{v.employee && ` · ${branchName[v.employee.branch_id] ?? ""}`} · {dayLabel(today)}{seen && ` · last in the app ${seen}`}</p>
        <TodoCard todos={todos} />
        {/* Phones have no side menu: show the person's menu as a card (CHRIS Nov 26). */}
        <div className="card view-menu-card"><StaticMenu hubs={menuFor(v.roles)} title={`${first}'s menu`} /></div>
        {notices?.ok && (
          <div className="card">
            <h2 className="notices-head">Notifications{notices.unread > 0 && <span className="nav-badge inline">{notices.unread}</span>}
              {notices.unread > 0 && <span className="count">unread</span>}</h2>
            {notices.latest.length === 0 ? <p className="muted small">None yet.</p> : (
              <ul className="view-notices">
                {notices.latest.map((n, i) => (
                  <li key={i} className={n.read ? "" : "unread"}>
                    <span className="vn-icon" aria-hidden>{(n.kind ?? "").startsWith("CHAT") ? "💬" : n.kind === "PHOTOS_DUE" ? "📷" : (n.kind ?? "").includes("NTE") || (n.kind ?? "").includes("IR") ? "⏰" : "🔔"}</span>
                    <strong>{!n.read && <span className="vn-dot" title="Unread" />}{n.title}</strong>
                    <span className="vn-time">{new Date(n.created_at).toLocaleString("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                    {n.body && <span className="small" style={{ gridColumn: "2 / -1" }}>{n.body}</span>}
                    {!n.read && <span className="small muted" style={{ gridColumn: "2 / -1" }}>Not read yet</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {v.employee?.commission_eligible && (
          <div className="grid">
            <div className="card stat"><div className="label">Approved commission this month</div><div className="value">{centsToPhp(v.month_approved_cents)}</div></div>
            <div className="card stat"><div className="label">Waiting sign-off</div><div className="value">{centsToPhp(v.unsigned.cents)}</div>
              {v.employee && <div className="note"><Link href={`/people/${v.employee.id}`}>See every commission line →</Link></div>}</div>
          </div>
        )}
        <div className="card">
          <h2>Details</h2>
          <dl className="kv" style={{ borderTop: 0, paddingTop: 0 }}>
            <dt>Name</dt><dd>{v.name}</dd>
            <dt>Position</dt><dd>{v.employee?.position ?? "Not set yet"}</dd>
            <dt>Home branch</dt><dd>{v.employee ? branchName[v.employee.branch_id] : "Not set yet"}</dd>
            <dt>Commission</dt><dd>{v.employee ? (v.employee.commission_eligible ? "Yes, 5% of amount paid" : "No") : "Not set yet"}</dd>
            <dt>App access</dt><dd>{scope.join("; ") || "None yet"}</dd>
            {v.joined_at && <><dt>Joined the app</dt><dd>{v.joined_at.slice(0, 10)}</dd></>}
          </dl>
        </div>
      </main>
    </>
  );
}
