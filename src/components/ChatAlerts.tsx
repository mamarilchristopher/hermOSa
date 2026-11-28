"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createClient } from "@/lib/supabase/browser";
import { CHAT_READ_EVENT, firstName, playChatSound } from "@/lib/chatSounds";
import { IconMegaphone } from "./Icons";

type Notice = { id: string; room_id: string; created_at: string; sender: string; sender_first?: string | null; room_name: string | null; text: string };

/**
 * On every page (v0.49): chat sounds for new messages, and for staff a can't-miss notice when management
 * (owners or the GM) messages them. The notice stays until they open the chat (CHRIS, Nov 26).
 */
export function ChatAlerts({ me, management }: { me: string; management: boolean }) {
  const supabase = useMemo(() => createClient(), []);
  const path = usePathname();
  const [list, setList] = useState<Notice[]>([]);
  const [later, setLater] = useState<string | null>(null);
  useEffect(() => { try { setLater(sessionStorage.getItem("mgmt-later")); } catch { /* ignore */ } }, []);
  const snooze = (id: string) => { setLater(id); try { sessionStorage.setItem("mgmt-later", id); } catch { /* ignore */ } };
  const load = useCallback(async () => {
    if (management) return;
    const { data } = await supabase.rpc("chat_mgmt_unread");
    if (Array.isArray(data)) setList(data as Notice[]);
  }, [supabase, management]);

  useEffect(() => { void load(); }, [load, path]);
  // Opening the chat clears the notice right away (CHRIS, Nov 26).
  useEffect(() => {
    const h = () => { void load(); };
    addEventListener(CHAT_READ_EVENT, h);
    return () => removeEventListener(CHAT_READ_EVENT, h);
  }, [load]);
  useEffect(() => {
    const ch = supabase.channel(`chat-alerts-${me}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "chat_messages" }, (p) => {
        const m = p.new as { sender_id: string; from_management: boolean; mentions?: string[]; mention_all?: boolean };
        if (m.sender_id === me) return;
        if (m.from_management && !management) { playChatSound("management"); setLater(null); void load(); }
        else if (m.mention_all || m.mentions?.includes(me)) playChatSound("mention");
        else playChatSound("message");
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "chat_members", filter: `user_id=eq.${me}` }, () => { void load(); })
      .subscribe();
    return () => { void supabase.removeChannel(ch); };
  }, [supabase, me, management, load]);

  const top = list.find((n) => path !== `/chat/${n.room_id}`);
  if (!top) return null;
  const from = `Message from ${top.sender_first || firstName(top.sender)}`;
  const rest = list.filter((n) => n.room_id !== top.room_id).length;
  // "Later" shrinks it to a pulsing pill until a newer message from management arrives.
  if (later === top.id) {
    return (
      <Link href={`/chat/${top.room_id}`} className="mgmt-pill" role="status">
        <IconMegaphone className="ic-lead" />{from}{list.length > 1 ? ` (${list.length})` : ""}
      </Link>
    );
  }
  return (
    <div className="mgmt-alert" role="alertdialog" aria-live="assertive" aria-label={from}>
      <div className="mgmt-alert-card">
        <span className="mgmt-alert-tag with-ic"><IconMegaphone />{from}</span>
        <strong className="mgmt-alert-from">{top.sender}{top.room_name ? ` in ${top.room_name}` : ""}</strong>
        <p className="mgmt-alert-text">{top.text}</p>
        {rest > 0 && <p className="small mgmt-alert-more">+ {rest} more from management</p>}
        <div className="mgmt-alert-actions">
          <button type="button" className="secondary" onClick={() => snooze(top.id)}>Later</button>
          <Link href={`/chat/${top.room_id}`} className="button">Open and reply</Link>
        </div>
      </div>
    </div>
  );
}
