"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/browser";
import { Avatar } from "./Avatar";
import { IconChat, IconSend } from "./Icons";
import { CHAT_READ_EVENT } from "@/lib/chatSounds";

/**
 * Chat heads (v0.74, CHRIS Nov 26, "like on Facebook", Option A). On every page except Chat:
 * - PC: the 4 most recent chats float as faces in the bottom-right corner (unread count, green dot when online).
 *   Tap a face for a small chat window (up to 2 side by side); ⤢ opens the full Chat page.
 * - Phone: one gold chat bubble above the bottom menu; it opens a quick chats sheet, then the chat.
 * Only the person's own chats are listed: the same chat_list / chat_messages rules as the Chat page (private chats).
 */
type Room = {
  id: string; kind: "DM" | "GROUP"; name: string | null; photo_path: string | null; icon_path?: string | null;
  last_at: string; unread: number; mgmt_unread?: number; members: number;
  last: { sender: string; mine: boolean; text: string } | null;
};
type Msg = { id: string; room_id: string; sender_id: string; body: string | null; photo_path: string | null; gif_url: string | null; created_at: string; deleted_at: string | null };
type Member = { id: string; name: string };

const HEADS = 4;
const time = (iso: string) => new Date(iso).toLocaleTimeString("en-PH", { timeZone: "Asia/Manila", hour: "numeric", minute: "2-digit" });
const day = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
const listTime = (iso: string) => (day(iso) === day(new Date().toISOString()) ? time(iso) : new Date(iso).toLocaleDateString("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric" }));
/** OnlineNow asks the dock to open a chat: detail { room, handled }. */
export const OPEN_CHAT_EVENT = "hermosa:open-chat";
const isPhone = () => typeof window !== "undefined" && window.matchMedia("(max-width: 900px)").matches;

export function ChatDock({ me }: { me: string }) {
  const supabase = useMemo(() => createClient(), []);
  const path = usePathname();
  const router = useRouter();
  const [rooms, setRooms] = useState<Room[] | null>(null);
  const [faces, setFaces] = useState<Record<string, string>>({}); // storage path -> signed link
  const [online, setOnline] = useState<Set<string>>(new Set()); // profile photo paths of people online now
  const [open, setOpen] = useState<string[]>([]); // open chat windows, newest first
  const [sheet, setSheet] = useState(false); // phone: quick chats sheet; PC: the "all chats" list
  const [incoming, setIncoming] = useState<Msg | null>(null);
  const signed = useRef(new Set<string>());

  const sign = useCallback(async (bucket: string, paths: (string | null | undefined)[]) => {
    const need = [...new Set(paths.filter((p): p is string => !!p && !signed.current.has(`${bucket}:${p}`)))];
    if (!need.length) return;
    need.forEach((p) => signed.current.add(`${bucket}:${p}`));
    const { data } = await supabase.storage.from(bucket).createSignedUrls(need, 3600);
    const add: Record<string, string> = {};
    for (const d of data ?? []) if (d.path && d.signedUrl) add[d.path] = d.signedUrl;
    setFaces((f) => ({ ...f, ...add }));
  }, [supabase]);

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc("chat_list");
    if (error || !Array.isArray(data)) return; // before update-0049: no chat
    const list = data as Room[];
    setRooms(list);
    void sign("profile-photos", list.filter((r) => r.kind === "DM").map((r) => r.photo_path));
    void sign("chat", list.map((r) => r.icon_path));
  }, [supabase, sign]);

  const loadOnline = useCallback(async () => {
    if (document.visibilityState !== "visible") return;
    const { data } = await supabase.rpc("online_now");
    if (Array.isArray(data)) setOnline(new Set((data as { photo?: string | null }[]).map((p) => p.photo).filter((x): x is string => !!x)));
  }, [supabase]);

  const onChatPage = path.startsWith("/chat");
  // Tapping someone in "Online now" opens your chat with them here (CHRIS Nov 26). Off the Chat page only.
  useEffect(() => {
    if (onChatPage) return;
    const on = (ev: Event) => {
      const d = (ev as CustomEvent<{ room: string; handled: boolean }>).detail;
      d.handled = true;
      void load().then(() => { setSheet(false); setOpen((o) => (isPhone() ? [d.room] : [d.room, ...o.filter((x) => x !== d.room)].slice(0, 2))); });
    };
    window.addEventListener(OPEN_CHAT_EVENT, on);
    return () => window.removeEventListener(OPEN_CHAT_EVENT, on);
  }, [onChatPage, load]);
  // Phone (CHRIS Nov 26): while a chat window is open, the page behind stays still so scrolling moves only the chat.
  useEffect(() => {
    if (!open.length || !isPhone()) return;
    const html = document.documentElement, body = document.body;
    const prev = [html.style.overflow, body.style.overflow];
    html.style.overflow = "hidden"; body.style.overflow = "hidden";
    return () => { html.style.overflow = prev[0]; body.style.overflow = prev[1]; };
  }, [open.length]);
  useEffect(() => { setSheet(false); if (isPhone()) setOpen([]); }, [path]);
  useEffect(() => { if (!onChatPage) void load(); }, [load, onChatPage, path]);
  useEffect(() => {
    void loadOnline();
    const a = setInterval(() => { void loadOnline(); }, 30000);
    const b = setInterval(() => { void load(); }, 30000);
    const read = () => { void load(); };
    addEventListener(CHAT_READ_EVENT, read);
    return () => { clearInterval(a); clearInterval(b); removeEventListener(CHAT_READ_EVENT, read); };
  }, [load, loadOnline]);
  // Live: the database only sends messages from chats this person is in.
  useEffect(() => {
    const ch = supabase.channel(`chat-dock-${me}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "chat_messages" }, (p) => { setIncoming(p.new as Msg); void load(); })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "chat_messages" }, (p) => { setIncoming(p.new as Msg); })
      .subscribe();
    return () => { void supabase.removeChannel(ch); };
  }, [supabase, me, load]);

  if (onChatPage || !rooms || rooms.length === 0) return null;

  const byId = new Map(rooms.map((r) => [r.id, r]));
  // Faces: unread chats first, then the most recent.
  const heads = [...rooms].sort((a, b) => (b.unread > 0 ? 1 : 0) - (a.unread > 0 ? 1 : 0) || b.last_at.localeCompare(a.last_at)).slice(0, HEADS);
  const unread = rooms.reduce((n, r) => n + (r.unread || 0), 0);
  const face = (r: Room, size: number) => {
    if (r.kind === "DM") return <Avatar name={r.name ?? "?"} url={r.photo_path ? faces[r.photo_path] : null} size={size} />;
    // eslint-disable-next-line @next/next/no-img-element
    return <img className="dock-group" src={r.icon_path && faces[r.icon_path] ? faces[r.icon_path] : "/hermosa-logo.png"} alt="" style={{ width: size, height: size }} />;
  };
  const isOn = (r: Room) => r.kind === "DM" && !!r.photo_path && online.has(r.photo_path);
  const openRoom = (id: string) => {
    setSheet(false);
    if (isPhone()) { setOpen([id]); return; }
    setOpen((o) => [id, ...o.filter((x) => x !== id)].slice(0, 2));
  };
  const close = (id: string) => setOpen((o) => o.filter((x) => x !== id));

  const list = (
    <div className="dock-list" role="dialog" aria-label="Recent chats">
      <div className="dock-list-head"><strong>Chats</strong><Link href="/chat" className="small">Open Chat</Link></div>
      <ul>
        {rooms.slice(0, 12).map((r) => (
          <li key={r.id}>
            <button type="button" className={`dock-row ${r.unread ? "unread" : ""}`} onClick={() => openRoom(r.id)}>
              <span className="dock-face">{face(r, 40)}{isOn(r) && <span className="dock-dot" aria-label="Online" />}</span>
              <span className="dock-row-text">
                <span className="dock-row-top"><strong>{r.name ?? "Chat"}</strong><span className="small muted">{listTime(r.last_at)}</span></span>
                <span className="dock-row-last">{r.last ? `${r.last.mine ? "You: " : r.kind === "GROUP" ? `${r.last.sender.split(" ")[0]}: ` : ""}${r.last.text}` : "Say hi"}</span>
              </span>
              {r.unread > 0 && <span className="nav-badge">{r.unread > 99 ? "99+" : r.unread}</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );

  return (
    <div className="chat-dock">
      {/* PC: the faces column */}
      <div className="dock-heads" aria-label="Recent chats">
        {heads.map((r) => (
          <button key={r.id} type="button" className={`dock-head ${open.includes(r.id) ? "on" : ""}`} title={r.name ?? "Chat"} aria-label={`${r.name ?? "Chat"}${r.unread ? `, ${r.unread} unread` : ""}`} onClick={() => (open.includes(r.id) ? close(r.id) : openRoom(r.id))}>
            {face(r, 48)}
            {isOn(r) && <span className="dock-dot" aria-hidden />}
            {r.unread > 0 && <span className="dock-count">{r.unread > 99 ? "99+" : r.unread}</span>}
          </button>
        ))}
        <button type="button" className="dock-head dock-all" title="All chats" aria-label="All chats" onClick={() => setSheet((s) => !s)}><IconChat /></button>
      </div>
      {/* Phone: one bubble */}
      {open.length === 0 && (
        <button type="button" className="dock-bubble" aria-label={`Chats${unread ? `, ${unread} unread` : ""}`} onClick={() => setSheet((s) => !s)}>
          <IconChat />{unread > 0 && <span className="dock-count">{unread > 99 ? "99+" : unread}</span>}
        </button>
      )}
      {sheet && <><div className="dock-backdrop" aria-hidden onClick={() => setSheet(false)} />{list}</>}
      {/* Phone: tapping outside the open chat closes it. Hidden on PC. */}
      {open.length > 0 && <div className="dock-backdrop dock-win-backdrop" aria-hidden onClick={() => setOpen([])} />}
      <div className="dock-windows">
        {open.map((id) => byId.get(id) && (
          <MiniChat key={id} room={byId.get(id)!} me={me} face={face(byId.get(id)!, 30)} online={isOn(byId.get(id)!)} incoming={incoming} sign={sign} photos={faces}
            onClose={() => close(id)} onExpand={() => { close(id); router.push(`/chat/${id}`); }} onSent={load} />
        ))}
      </div>
    </div>
  );
}

function MiniChat({ room, me, face, online, incoming, sign, photos, onClose, onExpand, onSent }: {
  room: Room; me: string; face: React.ReactNode; online: boolean; incoming: Msg | null; photos: Record<string, string>;
  sign: (bucket: string, paths: (string | null | undefined)[]) => Promise<void>; onClose: () => void; onExpand: () => void; onSent: () => void;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [msgs, setMsgs] = useState<Msg[] | null>(null);
  const [members, setMembers] = useState<Map<string, string>>(new Map());
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const toEnd = () => requestAnimationFrame(() => scroller.current?.scrollTo({ top: scroller.current.scrollHeight }));
  const markRead = useCallback(() => {
    void supabase.rpc("chat_mark_read", { p_room: room.id }).then(() => window.dispatchEvent(new Event(CHAT_READ_EVENT)));
  }, [supabase, room.id]);

  useEffect(() => {
    let gone = false;
    (async () => {
      const [{ data: r }, { data: m }] = await Promise.all([
        supabase.rpc("chat_room", { p_room: room.id }),
        supabase.from("chat_messages").select("id,room_id,sender_id,body,photo_path,gif_url,created_at,deleted_at").eq("room_id", room.id).order("created_at", { ascending: false }).limit(30),
      ]);
      if (gone) return;
      if (!r?.ok) { setError("That chat isn't available."); setMsgs([]); return; }
      setMembers(new Map(((r.members ?? []) as Member[]).map((x) => [x.id, x.name])));
      const list = ((m ?? []) as Msg[]).reverse();
      setMsgs(list);
      void sign("chat", list.map((x) => x.photo_path));
      markRead();
      toEnd();
      if (!("ontouchstart" in window)) box.current?.focus();
    })();
    return () => { gone = true; };
  }, [supabase, room.id, sign, markRead]);

  // New or deleted messages in this chat arrive through the dock's live channel.
  useEffect(() => {
    if (!incoming || incoming.room_id !== room.id) return;
    setMsgs((list) => {
      if (!list) return list;
      return list.some((x) => x.id === incoming.id) ? list.map((x) => (x.id === incoming.id ? incoming : x)) : [...list, incoming];
    });
    void sign("chat", [incoming.photo_path]);
    if (incoming.sender_id !== me && document.visibilityState === "visible") markRead();
    const el = scroller.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) toEnd();
  }, [incoming, room.id, me, sign, markRead]);

  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true); setError(null);
    const { data, error: e } = await supabase.rpc("chat_send", { p_room: room.id, p_body: body, p_photo_path: null, p_gif_url: null, p_mentions: [], p_all: false });
    setBusy(false);
    if (e || !data?.ok) { setError(data?.error === "FORBIDDEN" ? "You can't send in this chat." : "Couldn't send. Check your connection and try again."); return; }
    setText("");
    const m = data.message as Msg;
    setMsgs((list) => (list && !list.some((x) => x.id === m.id) ? [...list, m] : list));
    toEnd();
    onSent();
  };

  const group = room.kind === "GROUP";
  return (
    <section className="mini-chat" aria-label={room.name ?? "Chat"}>
      <header className="mini-head">
        <span className="dock-face">{face}{online && <span className="dock-dot" aria-hidden />}</span>
        <span className="mini-title"><strong>{room.name ?? "Chat"}</strong>{online ? <span className="mini-on">Active now</span> : group ? <span className="small muted">{room.members} people</span> : null}</span>
        <button type="button" className="icon-btn" title="Open in Chat" aria-label="Open in Chat" onClick={onExpand}>⤢</button>
        <button type="button" className="icon-btn" title="Close" aria-label="Close chat" onClick={onClose}>✕</button>
      </header>
      <div className="mini-scroll" ref={scroller}>
        {msgs === null && <p className="small muted mini-note">Loading…</p>}
        {msgs?.length === 0 && !error && <p className="small muted mini-note">No messages yet. Say hi!</p>}
        {msgs?.map((m, i) => {
          const mine = m.sender_id === me;
          const showName = group && !mine && msgs[i - 1]?.sender_id !== m.sender_id;
          return (
            <div key={m.id} className={`mini-msg ${mine ? "mine" : ""}`}>
              {showName && <span className="mini-name">{(members.get(m.sender_id) ?? "").split(" ")[0]}</span>}
              {m.deleted_at ? <span className="mini-bubble deleted">Message deleted</span>
                // eslint-disable-next-line @next/next/no-img-element
                : m.photo_path ? (photos[m.photo_path] ? <img className="mini-photo" src={photos[m.photo_path]} alt="Photo" /> : <span className="mini-bubble">Photo</span>)
                // eslint-disable-next-line @next/next/no-img-element
                : m.gif_url ? <img className="mini-photo" src={m.gif_url} alt="GIF" />
                : <span className="mini-bubble" title={time(m.created_at)}>{m.body}</span>}
            </div>
          );
        })}
      </div>
      {error && <p className="error small mini-note">{error}</p>}
      <form className="mini-send" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <textarea ref={box} rows={1} value={text} placeholder="Type a message…" aria-label="Message" maxLength={4000}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }} />
        <button type="submit" className="icon-btn" aria-label="Send" disabled={busy || !text.trim()}><IconSend /></button>
      </form>
    </section>
  );
}
