import type { Access } from "@/lib/access";
import { can } from "@/lib/access";
import { IconLogout, IconShield } from "./Icons";
import { NavLinks, type NavItem } from "./NavLinks";

const ROLE_LABEL: Record<string, string> = {
  OWNER: "Owner", FINANCE: "Finance", MANAGER: "Manager", CASHIER: "Cashier", HR: "HR",
  MARKETING: "Marketing", CLINICIAN: "Clinician", INVENTORY: "Inventory", AUDITOR: "Auditor",
};

/** App navigation: a sidebar on wide screens, a top bar plus bottom tabs on phones. */
export function TopBar({ access }: { access: Access }) {
  const importer = access.grants.some((g) => ["OWNER", "FINANCE", "MANAGER", "AUDITOR"].includes(g.role));
  const filler = access.grants.some((g) => ["OWNER", "FINANCE", "MANAGER"].includes(g.role));
  const items: NavItem[] = [
    { href: "/", label: "Sales dashboard", short: "Sales", icon: "chart" },
    ...(filler ? [{ href: "/sales/missing", label: "Missing days", short: "Missing", icon: "calendar" } as NavItem] : []),
    ...(importer ? [{ href: "/imports", label: "Imports", short: "Imports", icon: "upload" } as NavItem] : []),
    ...(can(access, ["OWNER"], null) ? [{ href: "/admin/users", label: "Users and roles", short: "Users", icon: "users" } as NavItem] : []),
  ];
  const initials = access.display_name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "?";
  const role = [...new Set(access.grants.map((g) => ROLE_LABEL[g.role] ?? g.role))].join(", ") || "No role yet";

  return (
    <>
      <aside className="sidebar">
        <div className="brand">
          {/* Approved logo, original aspect ratio preserved via width + auto height. */}
          <img src="/hermosa-logo.png" alt="Hermosa Aesthetics" />
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
        <img src="/hermosa-logo.png" alt="Hermosa Aesthetics" />
        <span className="avatar" title={`${access.display_name} · ${role}`}>{initials}</span>
        <form action="/auth/signout" method="post">
          <button className="icon-btn" type="submit" aria-label="Sign out"><IconLogout /></button>
        </form>
      </header>
      <NavLinks items={items} variant="tabs" />
    </>
  );
}
