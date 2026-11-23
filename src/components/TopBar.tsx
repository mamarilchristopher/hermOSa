import Link from "next/link";
import type { Access } from "@/lib/access";
import { can } from "@/lib/access";

export function TopBar({ access }: { access: Access }) {
  const importer = access.grants.some((g) => ["OWNER", "FINANCE", "MANAGER", "AUDITOR"].includes(g.role));
  return (
    <header className="topbar">
      {/* Approved logo, original aspect ratio preserved via height + auto width. */}
      <img src="/hermosa-logo.png" alt="Hermosa Aesthetics" />
      <nav>
        <Link href="/">Dashboard</Link>
        {importer && <Link href="/imports">Historical imports</Link>}
        {can(access, ["OWNER"], null) && <Link href="/admin/users">Users</Link>}
      </nav>
      <span className="who">
        {access.display_name}
        {access.mfa ? " · MFA on" : ""}
      </span>
      <form action="/auth/signout" method="post">
        <button className="secondary" type="submit">Sign out</button>
      </form>
    </header>
  );
}
