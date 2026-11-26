import type { Hub } from "@/components/NavLinks";

/** Menu grouped into hubs (v0.48, CHRIS Nov 25), worked out from a person's roles. Used for your own menu and for View as
 *  (CHRIS Nov 26: see the side menu the person you're viewing sees). Counts are badges; View as passes none. */
export type MenuGrant = { role: string; branch_id: string | null };
export type MenuCounts = { chat?: number; overdue?: number; leave?: number; details?: number; photos?: number; joins?: number };

export function menuFor(grants: MenuGrant[], c: MenuCounts = {}): Hub[] {
  const has = (roles: string[]) => grants.some((g) => roles.includes(g.role));
  const orgWide = (role: string) => grants.some((g) => g.role === role && g.branch_id === null);
  const owner = orgWide("OWNER");
  const gm = !owner && orgWide("MANAGER");
  const approver = has(["OWNER", "MANAGER"]);
  const detailsApprover = owner || gm;
  const logger = has(["OWNER", "FINANCE", "MANAGER", "CASHIER", "CLINICIAN", "HR", "AUDITOR"]);
  const people = has(["OWNER", "FINANCE", "MANAGER", "HR", "AUDITOR"]);
  const importer = has(["OWNER", "FINANCE", "MANAGER", "AUDITOR"]);
  const filler = has(["OWNER", "FINANCE", "MANAGER"]);
  const management = has(["OWNER", "FINANCE", "AUDITOR", "MANAGER"]);
  // update-0057: every employee sees both photo tabs.
  const archiver = grants.length > 0;
  // Bookings (update-0040, update-0071): CSRs, owners and the GM book; every employee sees them.
  const booker = has(["CSR", "OWNER", "MANAGER", "CLINICIAN", "CASHIER"]);
  const n = (x?: number) => (x && x > 0 ? x : undefined);
  return ([
    // CHRIS Nov 27 (v0.89.1): My day sits on Home for the GM and the owners.
    { key: "home", label: "Home", short: "Home", icon: "home", tabs: [{ href: "/me", label: "Home" }, ...(owner || gm ? [{ href: "/focus", label: "My day" }] : [])] },
    { key: "time", label: "Time clock", short: "Clock", icon: "clock", tabs: [{ href: "/time", label: "Time clock" }] },
    // Team chat (v0.49, update-0049): private 1-on-1 and group chats; the badge counts unread messages.
    { key: "chat", label: "Chat", short: "Chat", icon: "chat", tabs: [{ href: "/chat", label: "Chat", badge: n(c.chat) }] },
    // CHRIS Nov 27 (v0.89.1): its own Business hub: the Business page, the Dashboard and the promo generator.
    { key: "business", label: "Business", short: "Business", icon: "briefcase", tabs: [
      ...(management ? [{ href: "/business", label: "Business" }, { href: "/", label: "Dashboard" }] : []),
      // update-0086 (CHRIS Nov 27): promo ideas every Monday, and the builder. Owners and the GM.
      ...(owner || gm ? [{ href: "/promos", label: "Promos" }] : []),
    ] },
    { key: "sales", label: "Sales", short: "Sales", icon: "chart", tabs: [
      ...(filler ? [{ href: "/sales/daily", label: "Daily sales" }] : []),
      ...(filler ? [{ href: "/sales/missing", label: "Missing days" }] : []),
      ...(importer ? [{ href: "/imports", label: "Imports" }] : []),
      // update-0081 (CHRIS Nov 26): Unresponsive bookings to call or message again. CSRs, owners and the GM.
      ...(owner || gm || has(["CSR"]) ? [{ href: "/bookings/followups", label: "Follow-ups" }] : []),
    ] },
    { key: "clinic", label: "Clinic", short: "Clinic", icon: "clipboard", tabs: [
      ...(logger ? [{ href: "/services", label: "Service log", badge: n(c.overdue) }] : []),
      ...(booker || archiver ? [{ href: "/bookings", label: "Bookings" }] : []),
      ...(owner || gm ? [{ href: "/services/prices", label: "Price list" }] : []),
      // update-0088 (CHRIS Nov 27): backjobs per staff, client and service.
      ...(owner || gm ? [{ href: "/clinic/backjobs", label: "Backjobs" }] : []),
      // Client photos (v0.53, update-0053): waivers and before/after per client; shared ones also in Social media.
      ...(archiver ? [{ href: "/clinic/archive", label: "Client archive" }, { href: "/clinic/social", label: "Social media" }] : []),
      // update-0075: proof of payment in its own folder (staff see their own entries, management sees all).
      ...(archiver ? [{ href: "/clinic/payments", label: "Proof of payment" }] : []),
      // update-0082 (CHRIS Nov 26): approved forms with every old version, for everyone.
      ...(archiver ? [{ href: "/documents", label: "Documents" }] : []),
    ] },
    { key: "team", label: "Team", short: "Team", icon: "week", tabs: [
      { href: "/schedule", label: "Schedule" },
      { href: "/leave", label: "Leave", badge: n(c.leave) },
      ...(approver ? [{ href: "/nte", label: "Late NTEs" }, { href: "/incidents", label: "Incident reports" }] : []),
    ] },
    { key: "pay", label: "Pay", short: "Pay", icon: "coins", tabs: [
      ...(owner || gm ? [{ href: "/payroll", label: "Payroll" }] : []),
      { href: "/payslips", label: "My payslips" },
    ] },
    { key: "people", label: "People", short: "People", icon: "people", tabs: [
      ...(people ? [{ href: "/people", label: "Employees" }] : []),
      ...(detailsApprover ? [{ href: "/admin/details", label: "Staff details", badge: n(c.details) },
                             { href: "/admin/photos", label: "Profile pictures", badge: n(c.photos) }] : []),
      ...(gm ? [{ href: "/admin/joins", label: "Join requests", badge: n(c.joins) }] : []),
    ] },
    { key: "settings", label: "Settings", short: "Settings", icon: "settings", tabs: [
      ...(owner ? [{ href: "/admin/users", label: "Users and roles" }] : []),
      ...(owner || gm ? [{ href: "/updates", label: "Updates" }] : []),
    ] },
  ] as Hub[]).filter((h) => h.tabs.length > 0).sort((a, b) => hubRank(a.key, management) - hubRank(b.key, management));
}

/** Menu order (CHRIS Nov 27, v0.89.1). Management: Home, Business, Clinic, Sales, then the rest, Time clock last (they
 *  don't clock in). Everyone else: Home, Clinic, Chat, Time clock (4th on the phone bar), then the rest. */
const MGMT_ORDER = ["home", "business", "clinic", "sales", "chat", "team", "pay", "people", "settings", "time"];
const STAFF_ORDER = ["home", "clinic", "chat", "time", "team", "sales", "pay", "people", "settings", "business"];
export function hubRank(key: string, management: boolean): number {
  const i = (management ? MGMT_ORDER : STAFF_ORDER).indexOf(key);
  return i < 0 ? 99 : i;
}
