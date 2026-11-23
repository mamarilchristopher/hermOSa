"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { IconCalendar, IconChart, IconClipboard, IconCoins, IconHome, IconPeople, IconUpload, IconUsers } from "./Icons";

const ICONS = { chart: IconChart, calendar: IconCalendar, upload: IconUpload, users: IconUsers, clipboard: IconClipboard, people: IconPeople, coins: IconCoins, home: IconHome };
export type NavItem = { href: string; label: string; short: string; icon: keyof typeof ICONS; badge?: number };

export function NavLinks({ items, variant }: { items: NavItem[]; variant: "side" | "tabs" }) {
  const path = usePathname();
  return (
    <nav className={variant === "side" ? "side-nav" : "tab-nav"} aria-label="Main">
      {items.map((it) => {
        const Icon = ICONS[it.icon];
        const active = it.href === "/" ? path === "/" : path.startsWith(it.href);
        return (
          <Link key={it.href} href={it.href} className={active ? "active" : undefined} aria-current={active ? "page" : undefined}>
            <Icon />
            <span>{variant === "side" ? it.label : it.short}</span>
            {it.badge ? <span className="nav-badge" aria-label={`${it.badge} overdue`}>{it.badge}</span> : null}
          </Link>
        );
      })}
    </nav>
  );
}
