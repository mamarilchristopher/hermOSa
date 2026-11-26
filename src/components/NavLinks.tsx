"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { IconCalendar, IconChart, IconClipboard, IconCoins, IconHome, IconIdCard, IconPen, IconPeople, IconUpload, IconUsers, IconWeek, IconClock, IconMore, IconSettings, IconChat } from "./Icons";

const ICONS = { chart: IconChart, calendar: IconCalendar, upload: IconUpload, users: IconUsers, clipboard: IconClipboard, people: IconPeople, coins: IconCoins, home: IconHome, idcard: IconIdCard, pen: IconPen, week: IconWeek, clock: IconClock, settings: IconSettings, chat: IconChat };

/** One page inside a hub (shown as a tab across the top of the page). */
export type HubTab = { href: string; label: string; badge?: number };
/** A menu item: a group of related pages (v0.48: Home, Time clock, Sales, Clinic, Team, Pay, People, Settings; v0.49 adds Chat). */
export type Hub = { key: string; label: string; short: string; icon: keyof typeof ICONS; tabs: HubTab[] };

const matches = (path: string, href: string) => (href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`));

/** The hub and tab the current page belongs to: the longest matching tab link wins (/services/prices over /services). */
export function activeOf(hubs: Hub[], path: string): { hub: string | null; tab: string | null } {
  let best: { hub: string; tab: string; len: number } | null = null;
  for (const h of hubs) for (const t of h.tabs) {
    if (matches(path, t.href) && (!best || t.href.length > best.len)) best = { hub: h.key, tab: t.href, len: t.href.length };
  }
  return { hub: best?.hub ?? null, tab: best?.tab ?? null };
}
const badgeOf = (h: Hub) => h.tabs.reduce((n, t) => n + (t.badge ?? 0), 0);

// Phone bottom bar: Home and Time clock always (v0.49: Chat comes next), then these hubs in this order; the rest go under More.
const PHONE_ORDER = ["chat", "clinic", "team", "sales", "pay", "people", "settings"];

export function NavLinks({ hubs, variant }: { hubs: Hub[]; variant: "side" | "tabs" }) {
  const path = usePathname();
  const [more, setMore] = useState(false);
  useEffect(() => setMore(false), [path]);
  const { hub: active } = activeOf(hubs, path);

  const link = (h: Hub, short: boolean) => {
    const Icon = ICONS[h.icon];
    const on = h.key === active;
    const badge = badgeOf(h);
    return (
      <Link key={h.key} href={h.tabs[0].href} className={on ? "active" : undefined} aria-current={on ? "page" : undefined}>
        <Icon />
        <span>{short ? h.short : h.label}</span>
        {badge ? <span className="nav-badge" aria-label={`${badge} waiting`}>{badge}</span> : null}
      </Link>
    );
  };

  if (variant === "side") return <nav className="side-nav" aria-label="Main">{hubs.map((h) => link(h, false))}</nav>;

  const fixed = hubs.filter((h) => h.key === "home" || h.key === "time");
  const rest = PHONE_ORDER.map((k) => hubs.find((h) => h.key === k)).filter((h): h is Hub => !!h);
  const fitsAll = fixed.length + rest.length <= 5;
  const shown = fitsAll ? rest : rest.slice(0, 2);
  const hidden = fitsAll ? [] : rest.slice(2);
  const moreOn = hidden.some((h) => h.key === active);
  const moreBadge = hidden.reduce((n, h) => n + badgeOf(h), 0);
  return (
    <>
      {more && hidden.length > 0 && (
        <div className="more-sheet" role="menu">
          {hidden.map((h) => link(h, false))}
        </div>
      )}
      <nav className="tab-nav" aria-label="Main">
        {fixed.map((h) => link(h, true))}
        {shown.map((h) => link(h, true))}
        {hidden.length > 0 && (
          <button type="button" className={`tab-more${moreOn || more ? " active" : ""}`} aria-expanded={more} onClick={() => setMore((v) => !v)}>
            <IconMore />
            <span>More</span>
            {moreBadge ? <span className="nav-badge" aria-label={`${moreBadge} waiting`}>{moreBadge}</span> : null}
          </button>
        )}
      </nav>
    </>
  );
}

/** Tabs across the top of the page for the pages in the current hub (hidden when the hub has one page). */
export function HubTabs({ hubs }: { hubs: Hub[] }) {
  const path = usePathname();
  const { hub, tab } = activeOf(hubs, path);
  const h = hubs.find((x) => x.key === hub);
  if (!h || h.tabs.length < 2) return null;
  return (
    <div className="hub-bar">
      <nav className="segmented hub-tabs" aria-label={h.label}>
        {h.tabs.map((t) => (
          <Link key={t.href} href={t.href} className={t.href === tab ? "on" : undefined} aria-current={t.href === tab ? "page" : undefined}>
            {t.label}
            {t.badge ? <span className="tab-badge">{t.badge}</span> : null}
          </Link>
        ))}
      </nav>
    </div>
  );
}

/** View as (CHRIS Nov 26): the side menu exactly as the viewed person sees it, with each item's tabs listed under it.
 *  Read only: the items aren't links, so nothing opens as you by mistake. */
export function StaticMenu({ hubs, title }: { hubs: Hub[]; title: string }) {
  return (
    <nav className="side-nav static-menu" aria-label={title}>
      <span className="static-menu-title">{title}</span>
      {hubs.map((h) => {
        const Icon = ICONS[h.icon];
        return (
          <div key={h.key} className="static-hub">
            <span className="static-hub-row"><Icon /><span>{h.label}</span></span>
            {h.tabs.length > 1 && <ul>{h.tabs.map((t) => <li key={t.href}>{t.label}</li>)}</ul>}
          </div>
        );
      })}
    </nav>
  );
}
