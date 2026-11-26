import Link from "next/link";
import type { Access } from "@/lib/access";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/access";
import { IconLogout, IconShield } from "./Icons";
import { HubTabs, NavLinks, StaticMenu, type Hub } from "./NavLinks";
import { ThemeToggle } from "./ThemeToggle";
import { OnlineNow } from "./OnlineNow";
import { ViewAsButton } from "./ViewAsButton";
import { byRankThenName, staffRank } from "@/lib/staffOrder";
import { Avatar } from "./Avatar";
import { photoUrls } from "@/lib/photos";
import { NotifBell } from "./NotifBell";
import { ChatAlerts } from "./ChatAlerts";
import { ChatDock } from "./ChatDock";
import { PhotoViewer } from "./PhotoViewer";
import { NotifyRequired } from "./Hermosapp";
import { manilaToday } from "@/lib/dates";
import { menuFor, type MenuGrant } from "@/lib/hubs";

const ROLE_LABEL: Record<string, string> = {
  OWNER: "Owner", FINANCE: "Finance", MANAGER: "Manager", CASHIER: "Cashier", HR: "HR",
  MARKETING: "Marketing", CLINICIAN: "Clinician", INVENTORY: "Inventory", AUDITOR: "Auditor", CSR: "CSR",
};

/** App navigation: a sidebar on wide screens, a top bar plus bottom tabs on phones. */
export async function TopBar({ access, viewing }: { access: Access; viewing?: { name: string; grants: MenuGrant[] } }) {
  const supabase = await createClient();
  const approver = access.grants.some((g) => g.role === "OWNER" || g.role === "MANAGER");
  const owner = can(access, ["OWNER"], null);
  const viewAs = access.grants.some((g) => (g.role === "OWNER" || g.role === "MANAGER") && g.branch_id === null);
  const gm = !owner && can(access, ["MANAGER"], null);
  const detailsApprover = owner || gm;
  const [{ data: overdueData }, { count: detailsWaiting }, { count: unreadNotices }, { data: viewPeople }, { count: joinsWaiting }, { data: meRow }, { count: photosWaiting }, { count: leaveWaiting }, { data: chatUnread }] = await Promise.all([
    approver ? supabase.rpc("overdue_commission_days") : Promise.resolve({ data: [] }),
    detailsApprover ? supabase.from("employee_detail_submissions").select("id", { count: "exact", head: true }).eq("state", "PENDING").neq("user_id", access.user_id) : Promise.resolve({ count: 0 }),
    supabase.from("notifications").select("id", { count: "exact", head: true }).is("read_at", null),
    viewAs ? supabase.rpc("view_as_people") : Promise.resolve({ data: null }),
    gm ? supabase.from("app_users").select("id", { count: "exact", head: true }).eq("join_status", "PENDING") : Promise.resolve({ count: 0 }),
    supabase.from("app_users").select("photo_path").eq("id", access.user_id).maybeSingle(), // errors (before update-0034) mean initials
    detailsApprover ? supabase.from("profile_photos").select("id", { count: "exact", head: true }).eq("state", "PENDING").neq("user_id", owner ? "00000000-0000-0000-0000-000000000000" : access.user_id) : Promise.resolve({ count: 0 }),
    detailsApprover ? supabase.from("leave_requests").select("id", { count: "exact", head: true }).eq("state", "PENDING").neq("filed_by", owner ? "00000000-0000-0000-0000-000000000000" : access.user_id) : Promise.resolve({ count: 0 }),
    supabase.rpc("chat_unread"), // errors (before update-0049) mean no badge
  ]);
  // Timed in right now (last punch today is IN): phone notifications are required (CHRIS Nov 26, red reminder).
  const { data: lastPunch } = await supabase.from("time_punches").select("kind").eq("user_id", access.user_id).eq("work_date", manilaToday()).order("punched_at", { ascending: false }).limit(1).maybeSingle();
  const timedIn = (lastPunch as { kind?: string } | null)?.kind === "IN";
  const myPhoto = (meRow as { photo_path?: string | null } | null)?.photo_path ?? null;
  const myPhotoUrl = myPhoto ? (await photoUrls(supabase, [myPhoto])).get(myPhoto) ?? null : null;
  // CHRIS Nov 26: View as lists people by seniority (General Manager first, CSRs last), then by name.
  const viewList = byRankThenName(Array.isArray(viewPeople) ? (viewPeople as { id: string; name: string; position: string | null }[]) : [],
    (p) => staffRank([], p.position), (p) => p.name);
  const overdue = (Array.isArray(overdueData) ? overdueData : []) as { code: string; name: string; date: string; pending: number }[];
  // Menu (v0.48 hubs; moved to lib/hubs so View as can show someone else's menu, CHRIS Nov 26). Role checks use only
  // grants that are in effect (owner-level roles need 2-step sign-in), as before.
  const live = access.grants.filter((g) => can(access, [g.role], g.branch_id));
  const hubs: Hub[] = menuFor(live, { chat: typeof chatUnread === "number" ? chatUnread : 0, overdue: overdue.length, leave: leaveWaiting ?? 0,
    details: detailsWaiting ?? 0, photos: photosWaiting ?? 0, joins: joinsWaiting ?? 0 });
  const role = [...new Set(access.grants.map((g) => ROLE_LABEL[g.role] ?? g.role))].join(", ") || "No role yet";

  return (
    <>
      <aside className="sidebar">
        {/* The logo goes Home (CHRIS Nov 26). Approved logo, original aspect ratio preserved via width + auto height. */}
        <Link href="/me" className="brand" aria-label="Home">
          <img className="logo-light" src="/hermosa-logo-transparent.png" alt="Hermosa Aesthetics" />
          <img className="logo-dark" src="/hermosa-logo-dark.png" alt="Hermosa Aesthetics" />
          <span className="brand-tag">OS</span>
        </Link>
        {/* View as sits above the menu so a long menu on a short laptop screen never pushes it out of sight. */}
        {viewList.length > 0 && <ViewAsButton people={viewList} variant="side" />}
        {viewing ? (
          <>
            <Link href="/me" className="static-menu-back small">← Back to my menu</Link>
            <StaticMenu hubs={menuFor(viewing.grants)} title={`${viewing.name.split(" ")[0]}'s menu`} />
          </>
        ) : <NavLinks hubs={hubs} variant="side" />}
        <div className="side-mode"><ThemeToggle variant="pill" /></div>
        <div className="me">
          <Avatar name={access.display_name} url={myPhotoUrl} />
          <span className="me-text">
            <strong>{access.display_name}</strong>
            <span>{role}{access.mfa && <span className="mfa" title="Signed in with 2-step verification"><IconShield /> 2FA</span>}</span>
          </span>
          <form action="/auth/signout" method="post">
            <button className="icon-btn" type="submit" title="Sign out" aria-label="Sign out"><IconLogout /></button>
          </form>
        </div>
      </aside>
      <header className="mobile-bar">
        <Link href="/me" className="mobile-home" aria-label="Home">
          <img className="logo-light" src="/hermosa-logo-transparent.png" alt="Hermosa Aesthetics" />
          <img className="logo-dark" src="/hermosa-logo-dark.png" alt="Hermosa Aesthetics" />
        </Link>
        <ThemeToggle />
        <a href="/me/photo" title={`${access.display_name} · ${role} · change your picture`}><Avatar name={access.display_name} url={myPhotoUrl} size={32} /></a>
        <form action="/auth/signout" method="post">
          <button className="icon-btn" type="submit" aria-label="Sign out"><IconLogout /></button>
        </form>
      </header>
      <NavLinks hubs={hubs} variant="tabs" />
      <div className="online-strip">
        <OnlineNow show />
        {viewList.length > 0 && <ViewAsButton people={viewList} />}
        <NotifBell />
      </div>
      {overdue.length > 0 && (
        <div className="alert-strip" role="status">
          <strong>Commission sign-off overdue:</strong>
          {overdue.slice(0, 6).map((o) => (
            <Link key={`${o.code}-${o.date}`} href={`/services?date=${o.date}&branch=${o.code}`}>
              {o.name.replace(/ \(.*\)$/, "")}, {o.date.slice(5).replace("-", "/")} ({o.pending})
            </Link>
          ))}
          {overdue.length > 6 && <span>+{overdue.length - 6} more days</span>}
        </div>
      )}
      <HubTabs hubs={hubs} />
      {/* v0.49: chat sounds, and the can't-miss notice when management messages staff. */}
      <ChatAlerts me={access.user_id} management={viewAs} />
      {/* v0.73.1: Facebook-style chat heads (PC) and chat bubble (phone) on every page except Chat. */}
      <ChatDock me={access.user_id} />
      <PhotoViewer />
      {timedIn && <NotifyRequired />}
    </>
  );
}
