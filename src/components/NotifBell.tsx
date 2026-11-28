"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { IconBell } from "./Icons";
import { loadInbox, markRead, type Inbox } from "@/app/inbox/actions";
import { IconText } from "./IconText";

const when = (iso: string) => new Date(iso).toLocaleString("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** Bell with to-dos and notices, like Facebook notifications (CHRIS Nov 25). Every item opens its page. */
export function NotifBell() {
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const path = usePathname();
  const refresh = useCallback(() => { loadInbox().then(setInbox, () => {}); }, []);

  useEffect(() => { refresh(); setOpen(false); }, [path, refresh]);
  useEffect(() => {
    const t = setInterval(refresh, 120000);
    return () => clearInterval(t);
  }, [refresh]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);

  const todos = inbox?.todos ?? [];
  const notices = inbox?.notices ?? [];
  const unread = notices.filter((n) => !n.read).length;
  const count = todos.length + unread;
  const urgent = todos.some((t) => t.urgent);
  const readOne = (id: string, read: boolean) => { if (!read) void markRead([id]).then(refresh); setOpen(false); };

  return (
    <div className="bell" ref={box}>
      <button type="button" className={`bell-btn ${open ? "on" : ""}`} onClick={() => { setOpen(!open); if (!open) refresh(); }}
        aria-label={`To do and notifications${count ? `, ${count} new` : ""}`} aria-expanded={open}>
        <IconBell />
        {count > 0 && <span className={`bell-count ${urgent ? "urgent" : ""}`}>{count > 99 ? "99+" : count}</span>}
      </button>
      {open && (
        <div className="bell-panel" role="dialog" aria-label="To do and notifications">
          <div className="bell-head"><strong>To do</strong>{todos.length > 0 && <span className="small muted">{todos.length}</span>}</div>
          {!inbox ? <p className="small muted bell-empty">Loading…</p> : todos.length === 0 ? <p className="small muted bell-empty">All caught up. Nothing is waiting on you.</p> : (
            <ul className="bell-list">
              {todos.map((t) => (
                <li key={t.text}><Link href={t.href} className={t.urgent ? "urgent" : ""} onClick={() => setOpen(false)}>
                  <span className="bell-dot" aria-hidden /><span><IconText text={t.text} /></span></Link></li>
              ))}
            </ul>
          )}
          <div className="bell-head">
            <strong>Notifications</strong>
            {unread > 0 && <button type="button" className="link-like small" onClick={() => void markRead(null).then(refresh)}>Mark all read</button>}
          </div>
          {notices.length === 0 ? <p className="small muted bell-empty">No notifications yet.</p> : (
            <ul className="bell-list">
              {notices.map((n) => {
                const inner = <><span className="bell-dot" aria-hidden /><span><strong>{n.title}</strong>{n.body && <><br /><span className="small">{n.body}</span></>}<br /><span className="small muted">{when(n.at)}{n.href ? ` · ${n.button}` : ""}</span></span></>;
                return (
                  <li key={n.id} className={n.read ? "read" : "unread"}>
                    {n.href ? <Link href={n.href} onClick={() => readOne(n.id, n.read)}>{inner}</Link>
                      : <button type="button" className="bell-item" onClick={() => readOne(n.id, n.read)}>{inner}</button>}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
