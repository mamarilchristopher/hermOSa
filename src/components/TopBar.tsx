import Link from "next/link";
import type { Access } from "@/lib/access";
import { createClient } from "@/lib/supabase/server";
import { can } from "@/lib/access";
import { IconLogout, IconShield } from "./Icons";
import { NavLinks, type NavItem } from "./NavLinks";
import { OnlineNow } from "./OnlineNow";

const ROLE_LABEL: Record<string, string> = {
  OWNER: "Owner", FINANCE: "Finance", MANAGER: "Manager", CASHIER: "Cashier", HR: "HR",
  MARKETING: "Marketing", CLINICIAN: "Clinician", INVENTORY: "Inventory", AUDITOR: "Auditor",
};

/** App navigation: a sidebar on wide screens, a top bar plus bottom tabs on phones. */
export async function TopBar({ access }: { access: Access }) {
  const supabase = await createClient();
  const approver = access.grants.some((g) => g.role === "OWNER" || g.role === "MANAGER");
  const owner = can(access, ["OWNER"], null);
  const [{ data: overdueData }, { count: detailsWaiting }, { count: unreadNotices }] = await Promise.all([
    approver ? supabase.rpc("overdue_commission_days") : Promise.resolve({ data: [] }),
    owner ? supabase.from("employee_detail_submissions").select("id", { count: "exact", head: true }).eq("state", "PENDING") : Promise.resolve({ count: 0 }),
    supabase.from("notifications").select("id", { count: "exact", head: true }).is("read_at", null),
  ]);
  const overdue = (Array.isArray(overdueData) ? overdueData : []) as { code: string; name: string; date: string; pending: number }[];
  const logger = access.grants.some((g) => ["OWNER", "FINANCE", "MANAGER", "CASHIER", "CLINICIAN", "HR", "AUDITOR"].includes(g.role));
  const people = access.grants.some((g) => ["OWNER", "FINANCE", "MANAGER", "HR", "AUDITOR"].includes(g.role));
  const importer = access.grants.some((g) => ["OWNER", "FINANCE", "MANAGER", "AUDITOR"].includes(g.role));
  const filler = access.grants.some((g) => ["OWNER", "FINANCE", "MANAGER"].includes(g.role));
  const management = access.grants.some((g) => ["OWNER", "FINANCE", "AUDITOR", "MANAGER"].includes(g.role));
  const items: NavItem[] = [
    { href: "/me", label: "Home", short: "Home", icon: "home", badge: unreadNotices || undefined },
    ...(management ? [{ href: "/", label: "Sales dashboard", short: "Sales", icon: "chart" } as NavItem] : []),
    ...(filler ? [{ href: "/sales/daily", label: "Daily Sales", short: "Daily", icon: "pen" } as NavItem] : []),
    ...(logger ? [{ href: "/services", label: "Service log", short: "Services", icon: "clipboard", badge: overdue.length || undefined } as NavItem] : []),
    ...(people ? [{ href: "/people", label: "Employees", short: "Staff", icon: "people" } as NavItem] : []),
    ...(filler ? [{ href: "/sales/missing", label: "Missing days", short: "Missing", icon: "calendar" } as NavItem] : []),
    ...(importer ? [{ href: "/imports", label: "Imports", short: "Imports", icon: "upload" } as NavItem] : []),
    ...(owner ? [{ href: "/admin/details", label: "Staff details", short: "Details", icon: "idcard", badge: detailsWaiting || undefined } as NavItem] : []),
    ...(owner ? [{ href: "/admin/users", label: "Users and roles", short: "Users", icon: "users" } as NavItem] : []),
  ];
  const initials = access.display_name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "?";
  const role = [...new Set(access.grants.map((g) => ROLE_LABEL[g.role] ?? g.role))].join(", ") || "No role yet";

  return (
    <>
      <aside className="sidebar">
        <div className="brand">
          {/* Approved logo, original aspect ratio preserved via width + auto height. */}
          <img src="/hermosa-logo-transparent.png" alt="Hermosa Aesthetics" />
          <span className="brand-tag">OS</span>
        </div>
        <NavLinks items={items} variant="side" />
        <div className="me">
          <span className="avatar" aria-hidden>{initials}</span>
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
        <img src="/hermosa-logo-transparent.png" alt="Hermosa Aesthetics" />
        <span className="avatar" title={`${access.display_name} · ${role}`}>{initials}</span>
        <form action="/auth/signout" method="post">
          <button className="icon-btn" type="submit" aria-label="Sign out"><IconLogout /></button>
        </form>
      </header>
      <NavLinks items={items} variant="tabs" />
      <OnlineNow show={access.grants.some((g) => g.role === "OWNER" || g.role === "MANAGER")} />
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
    </>
  );
}
