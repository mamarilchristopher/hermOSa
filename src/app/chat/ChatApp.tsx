"use client";
import { viewPhoto } from "@/components/PhotoViewer";
import { shrinkPhoto as shrink } from "@/lib/chatPhoto";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/browser";
import { Avatar } from "@/components/Avatar";
import { IconBack, IconBell, IconBellSlash, IconImage, IconInfo, IconMegaphone, IconPlus, IconSearch, IconSend, IconX } from "@/components/Icons";
import { CHAT_READ_EVENT, CHAT_SOUNDS_EVENT, firstName, playChatSound, setSoundsOn, soundsOn } from "@/lib/chatSounds";

/** Team chat client (v0.49, update-0049). Messages arrive live through Supabase Realtime; reading is limited to members by the database. */

export type ChatPerson = { id: string; name: string; photo_path: string | null; photo_url?: string | null };
export type ChatRoomRow = {
  id: string; kind: "DM" | "GROUP"; auto: boolean; name: string | null; photo_path: string | null; photo_url?: string | null;
  other_id: string | null; icon_path?: string | null; face_ids?: string[] | null; last_at: string; members: number; unread: number; mgmt_unread?: number; mgmt_from?: string | null; mention_unread?: number;
  last: { sender: string; mine: boolean; text: string; mgmt?: boolean } | null;
};
type Member = { id: string; name: string; photo_path: string | null; last_read_at: string };
type RoomInfo = { id: string; kind: "DM" | "GROUP"; auto: boolean; name: string; members: Member[] };
type Msg = { id: string; room_id: string; sender_id: string; body: string | null; photo_path: string | null; gif_url: string | null; from_management?: boolean; mentions?: string[]; mention_all?: boolean; reply_to?: string | null; created_at: string; deleted_at: string | null };
type Reaction = { message_id: string; user_id: string; emoji: string };
type Deleted = { message_id: string; body: string | null; photo_path: string | null; gif_url: string | null };
type Gif = { id: string; title: string; preview: string; url: string; w?: number; h?: number };

/** Quick reactions, and the emoji picker (v0.52). */
const QUICK = ["❤️", "👍", "😂", "😮", "😢", "🙏"];
const EMOJI = ("😀 😁 😂 🤣 😊 😍 🥰 😘 😉 😎 🤩 🥳 😇 🙂 🙃 😅 😆 😋 😜 🤪 🤗 🤭 🤔 🤨 😐 😴 😌 😔 😢 😭 😤 😡 🥺 😱 😳 🙄 😬 🤯 🤒 🤧 " +
  "👍 👎 👌 ✌️ 🤞 👏 🙌 🙏 💪 👋 🤝 ✋ 👀 💯 🔥 ✨ 🎉 🎊 🎂 🎁 💐 🌸 🌹 💖 ❤️ 🧡 💛 💚 💙 💜 🤍 💔 💕 💋 " +
  "☕ 🍰 🍕 🍔 🍜 🍩 🍫 🍓 🥤 🍷 ☀️ 🌙 ⭐ 🌈 ☔ ⏰ 📅 📌 ✅ ❌ ⚠️ ❓ ❗ 💰 💸 📣 📸 💅 💄 💉 🩺 🏥 🚗 🏃 🙋 🙆 🤷").split(" ");

const PAGE = 50;
const ERR: Record<string, string> = {
  FORBIDDEN: "You can't do that in this chat.", EMPTY_MESSAGE: "Type a message or add a photo.", MESSAGE_TOO_LONG: "That message is too long.",
  TOO_MANY: "That's enough reactions on one message.", NAME_REQUIRED: "Give the group a name.", ALL_NOT_ALLOWED: "Only owners and the GM can use @all.", NOT_FOUND: "That chat isn't available.", BAD_REQUEST: "That didn't work. Try again.",
};
const time = (iso: string) => new Date(iso).toLocaleTimeString("en-PH", { timeZone: "Asia/Manila", hour: "numeric", minute: "2-digit" });
const dayKey = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
const dayLabel = (iso: string) => {
  const k = dayKey(iso), today = dayKey(new Date().toISOString()), yest = dayKey(new Date(Date.now() - 86400000).toISOString());
  if (k === today) return "Today";
  if (k === yest) return "Yesterday";
  return new Date(iso).toLocaleDateString("en-PH", { timeZone: "Asia/Manila", weekday: "short", month: "short", day: "numeric", year: k.slice(0, 4) === today.slice(0, 4) ? undefined : "numeric" });
};
const listTime = (iso: string) => (dayKey(iso) === dayKey(new Date().toISOString()) ? time(iso) : new Date(iso).toLocaleDateString("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric" }));
const uuid = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`);

export function ChatApp({ me, initialRooms, people, initialRoom, management = false }: {
  me: { id: string; name: string; photo_url: string | null }; management?: boolean; initialRooms: ChatRoomRow[]; people: ChatPerson[]; initialRoom: string | null;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [rooms, setRooms] = useState(initialRooms);
  const [active, setActive] = useState<string | null>(initialRoom);
  const [info, setInfo] = useState<RoomInfo | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<null | "new" | "info">(null);
  const [picked, setPicked] = useState<string | null>(null); // message whose actions are open (phones)
  // CHRIS Nov 26: reply to a chosen message (update-0062); double-tap a message to heart it.
  const [replyTo, setReplyTo] = useState<Msg | null>(null);
  const lastTap = useRef<{ id: string; t: number } | null>(null);
  const [photos, setPhotos] = useState<Record<string, string>>({});
  // Reactions and, for owners and the GM, what deleted messages said (update-0052).
  const [reactions, setReactions] = useState<Reaction[]>([]);
  const [deleted, setDeleted] = useState<Record<string, Deleted>>({});
  const [picker, setPicker] = useState<null | "emoji" | "gif" | { react: string }>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [sounds, setSounds] = useState(true);
  // @mentions (update-0051): the open picker and who was picked.
  const [tagQuery, setTagQuery] = useState<string | null>(null);
  const [tagIndex, setTagIndex] = useState(0);
  const tagged = useRef(new Map<string, string>()); // id -> name
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const sync = () => setSounds(soundsOn());
    sync(); addEventListener(CHAT_SOUNDS_EVENT, sync);
    return () => removeEventListener(CHAT_SOUNDS_EVENT, sync);
  }, []);
  const activeRef = useRef(active);
  activeRef.current = active;
  const faces = useMemo(() => new Map(people.map((p) => [p.id, p.photo_url ?? null])), [people]);

  const refreshList = useCallback(async () => {
    const { data } = await supabase.rpc("chat_list");
    if (!Array.isArray(data)) return;
    // The open chat was deleted by someone else: close it.
    if (activeRef.current && !(data as ChatRoomRow[]).some((r) => r.id === activeRef.current)) { setActive(null); history.replaceState(null, "", "/chat"); }
    setRooms((old) => {
      const urls = new Map(old.map((r) => [r.id, r.photo_url]));
      return (data as ChatRoomRow[]).map((r) => ({ ...r, photo_url: urls.get(r.id) ?? (r.other_id ? faces.get(r.other_id) ?? null : null) }));
    });
  }, [supabase, faces]);

  const signPhotos = useCallback(async (list: { photo_path: string | null }[]) => {
    const need = list.map((m) => m.photo_path).filter((p): p is string => !!p);
    if (!need.length) return;
    const { data } = await supabase.storage.from("chat").createSignedUrls([...new Set(need)], 3600);
    const add: Record<string, string> = {};
    for (const d of data ?? []) if (d.path && d.signedUrl) add[d.path] = d.signedUrl;
    setPhotos((p) => ({ ...p, ...add }));
  }, [supabase]);

  // Group icons (update-0058) live in the private chat folder: sign any not signed yet.
  useEffect(() => {
    const need = rooms.map((r) => r.icon_path).filter((p): p is string => !!p && !photos[p]);
    if (need.length) void signPhotos(need.map((photo_path) => ({ photo_path })));
  }, [rooms, photos, signPhotos]);

  const markRead = useCallback((room: string) => {
    // Opening a chat clears its badges, the Management label and the management notice on every page.
    setRooms((rs) => rs.map((r) => (r.id === room ? { ...r, unread: 0, mgmt_unread: 0, mention_unread: 0 } : r)));
    void supabase.rpc("chat_mark_read", { p_room: room }).then(() => window.dispatchEvent(new Event(CHAT_READ_EVENT)));
  }, [supabase]);

  // Reactions on these messages; for owners and the GM, the deleted ones' text.
  const loadExtras = useCallback(async (room: string, list: Msg[]) => {
    const ids = list.map((m) => m.id);
    if (ids.length) {
      const { data } = await supabase.from("chat_reactions").select("message_id,user_id,emoji").in("message_id", ids).order("created_at");
      const got = (data ?? []) as Reaction[];
      setReactions((old) => [...old.filter((r) => !ids.includes(r.message_id)), ...got]);
    }
    if (management && list.some((m) => m.deleted_at)) {
      const { data } = await supabase.rpc("chat_deleted_list", { p_room: room });
      if (Array.isArray(data) && activeRef.current === room) {
        setDeleted(Object.fromEntries((data as Deleted[]).map((d) => [d.message_id, d])));
        void signPhotos(data as Deleted[]);
      }
    }
  }, [supabase, management, signPhotos]);

  // Open a chat: its members and the newest messages.
  useEffect(() => {
    setInfo(null); setMsgs([]); setMore(false); setError(null); setReplyTo(null); setPanel((p) => (p === "info" ? null : p));
    setReactions([]); setDeleted({}); setPicker(null);
    if (!active) return;
    let gone = false;
    setLoading(true);
    (async () => {
      const [{ data: r }, { data: m }] = await Promise.all([
        supabase.rpc("chat_room", { p_room: active }),
        supabase.from("chat_messages").select("*").eq("room_id", active).order("created_at", { ascending: false }).limit(PAGE),
      ]);
      if (gone) return;
      setLoading(false);
      if (!r?.ok) { setError(ERR.NOT_FOUND); return; }
      setInfo(r as RoomInfo);
      const list = ((m ?? []) as Msg[]).reverse();
      setMsgs(list);
      setMore(list.length === PAGE);
      void signPhotos(list);
      void loadExtras(active, list);
      markRead(active);
      requestAnimationFrame(() => scroller.current?.scrollTo({ top: scroller.current.scrollHeight }));
    })();
    return () => { gone = true; };
  }, [active, supabase, signPhotos, markRead, loadExtras]);

  // Live: new and deleted messages, and "seen" updates. The database only sends rows from chats you're in.
  useEffect(() => {
    const ch = supabase.channel(`chat-${me.id}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "chat_messages" }, (p) => {
        const m = p.new as Msg;
        if (m.room_id === activeRef.current) {
          setMsgs((list) => (list.some((x) => x.id === m.id) ? list : [...list, m]));
          void signPhotos([m]);
          if (m.sender_id !== me.id && document.visibilityState === "visible") markRead(m.room_id);
          const el = scroller.current;
          if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) requestAnimationFrame(() => el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }));
        }
        void refreshList();
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "chat_messages" }, (p) => {
        const m = p.new as Msg;
        setMsgs((list) => list.map((x) => (x.id === m.id ? m : x)));
        if (m.deleted_at && m.room_id === activeRef.current) void loadExtras(m.room_id, [m]);
      })
      // Removed for everyone (deleted by an owner or the GM).
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "chat_messages" }, (p) => {
        const id = (p.old as { id?: string }).id;
        if (id) setMsgs((list) => list.filter((x) => x.id !== id));
        void refreshList();
      })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "chat_reactions" }, (p) => {
        const r = p.new as Reaction & { room_id: string };
        if (r.room_id !== activeRef.current) return;
        setReactions((list) => (list.some((x) => x.message_id === r.message_id && x.user_id === r.user_id && x.emoji === r.emoji) ? list : [...list, r]));
      })
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "chat_reactions" }, (p) => {
        const r = p.old as Partial<Reaction>;
        if (r.message_id) setReactions((list) => list.filter((x) => !(x.message_id === r.message_id && x.user_id === r.user_id && x.emoji === r.emoji)));
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "chat_members" }, (p) => {
        const row = p.new as { room_id: string; user_id: string; last_read_at: string };
        setInfo((i) => (i && i.id === row.room_id ? { ...i, members: i.members.map((x) => (x.id === row.user_id ? { ...x, last_read_at: row.last_read_at } : x)) } : i));
      })
      .subscribe();
    // Fallback if live updates drop (weak signal): refresh the list every 30 seconds.
    const t = setInterval(() => { void refreshList(); }, 30000);
    return () => { clearInterval(t); void supabase.removeChannel(ch); };
  }, [supabase, me.id, refreshList, signPhotos, markRead, loadExtras]);

  // Back/forward buttons move between chats.
  useEffect(() => {
    const pop = () => setActive(location.pathname.split("/")[2] || null);
    addEventListener("popstate", pop);
    return () => removeEventListener("popstate", pop);
  }, []);
  const open = (id: string | null) => {
    setActive(id); setPanel(null); setText("");
    history.pushState(null, "", id ? `/chat/${id}` : "/chat");
  };

  const older = async () => {
    if (!active || !msgs.length) return;
    const el = scroller.current, before = el ? el.scrollHeight : 0;
    const { data } = await supabase.from("chat_messages").select("*").eq("room_id", active).lt("created_at", msgs[0].created_at).order("created_at", { ascending: false }).limit(PAGE);
    const list = ((data ?? []) as Msg[]).reverse();
    setMsgs((m) => [...list, ...m]);
    setMore(list.length === PAGE);
    void signPhotos(list);
    void loadExtras(active, list);
    requestAnimationFrame(() => { if (el) el.scrollTop = el.scrollHeight - before; });
  };

  const send = async (photo?: string, gif?: string) => {
    if (!active || busy) return;
    const body = photo || gif ? null : text.trim();
    if (!photo && !gif && !body) return;
    setBusy(true); setError(null);
    const isGroup = info?.kind === "GROUP";
    const ids = isGroup && body ? [...tagged.current].filter(([, n]) => body.includes(`@${n}`)).map(([id]) => id) : [];
    const all = isGroup && management && !!body && /(^|\s)@all\b/i.test(body);
    const args = { p_room: active, p_body: body, p_photo_path: photo ?? null, p_gif_url: gif ?? null, p_mentions: ids, p_all: all };
    const { data, error: e } = await supabase.rpc("chat_send", replyTo ? { ...args, p_reply_to: replyTo.id } : args);
    setBusy(false);
    if (e?.code === "PGRST202" && replyTo) { setError("Replies need database update-0062. Send it without replying for now."); return; }
    if (e || !data?.ok) { setError(ERR[data?.error] ?? "Couldn't send. Check your connection and try again."); return; }
    setReplyTo(null);
    if (!photo && !gif) { setText(""); tagged.current.clear(); setTagQuery(null); }
    if (gif) setPicker(null);
    playChatSound("sent");
    const m = data.message as Msg;
    setMsgs((list) => (list.some((x) => x.id === m.id) ? list : [...list, m]));
    void signPhotos([m]);
    requestAnimationFrame(() => scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" }));
    void refreshList();
  };

  const sendPhoto = async (file: File | undefined) => {
    if (!file || !active) return;
    if (!file.type.startsWith("image/")) { setError("Only photos can be sent."); return; }
    setBusy(true); setError(null);
    try {
      const blob = await shrink(file);
      const ext = blob.type === "image/gif" ? "gif" : "jpg";
      const path = `${active}/${me.id}/${uuid()}.${ext}`;
      const { error: e } = await supabase.storage.from("chat").upload(path, blob, { contentType: blob.type || "image/jpeg" });
      if (e) throw e;
      setBusy(false);
      await send(path);
    } catch {
      setBusy(false);
      setError("The photo didn't upload. Try again.");
    } finally {
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const remove = async (m: Msg) => {
    if (!confirm(management ? "Delete this message? It will be gone for everyone." : "Delete this message? Others will see \"Message deleted\".")) return;
    const { data } = await supabase.rpc("chat_delete_message", { p_message: m.id });
    if (!data?.ok) { setError("Couldn't delete that message."); return; }
    if (data.photo_path) void supabase.storage.from("chat").remove([data.photo_path]);
    if (data.gone) setMsgs((list) => list.filter((x) => x.id !== m.id));
    else setMsgs((list) => list.map((x) => (x.id === m.id ? { ...x, body: null, photo_path: null, gif_url: null, deleted_at: new Date().toISOString() } : x)));
    setPicked(null);
    void refreshList();
  };

  const react = async (messageId: string, emoji: string) => {
    setPicker(null); setPicked(null);
    const mineHas = (list: Reaction[]) => list.some((r) => r.message_id === messageId && r.user_id === me.id && r.emoji === emoji);
    const had = mineHas(reactions);
    const flip = (list: Reaction[], on: boolean) => (on
      ? (mineHas(list) ? list : [...list, { message_id: messageId, user_id: me.id, emoji }])
      : list.filter((r) => !(r.message_id === messageId && r.user_id === me.id && r.emoji === emoji)));
    setReactions((list) => flip(list, !had));
    const { data } = await supabase.rpc("chat_react", { p_message: messageId, p_emoji: emoji });
    if (!data?.ok) { setReactions((list) => flip(list, had)); setError(ERR[data?.error] ?? "Couldn't add that reaction."); }
  };
  const insertEmoji = (e: string) => {
    const el = box.current;
    const at = el?.selectionStart ?? text.length;
    const next = text.slice(0, at) + e + text.slice(el?.selectionEnd ?? at);
    setText(next);
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(at + e.length, at + e.length); });
  };

  // People you can tag: the chat's members A to Z (not you), plus @all for owners and the GM.
  const tagOptions = useMemo(() => {
    if (tagQuery === null || info?.kind !== "GROUP") return [];
    const q = tagQuery.toLowerCase();
    const list = info.members.filter((m) => m.id !== me.id && m.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)) || (q === "" && m.id !== me.id))
      .sort((a, b) => a.name.localeCompare(b.name)).map((m) => ({ id: m.id, name: m.name }));
    const uniq = [...new Map(list.map((x) => [x.id, x])).values()];
    return management && "all".startsWith(q) ? [{ id: "all", name: "all" }, ...uniq] : uniq;
  }, [tagQuery, info, me.id, management]);
  const onType = (value: string, caret: number) => {
    setText(value);
    const m = /(^|\s)@([^\s@]{0,30})$/.exec(value.slice(0, caret));
    if (m && info?.kind === "GROUP") { setTagQuery(m[2]); setTagIndex(0); } else setTagQuery(null);
  };
  const pickTag = (opt: { id: string; name: string }) => {
    const el = box.current;
    const caret = el?.selectionStart ?? text.length;
    const before = text.slice(0, caret).replace(/@([^\s@]{0,30})$/, `@${opt.name} `);
    const next = before + text.slice(caret);
    if (opt.id !== "all") tagged.current.set(opt.id, opt.name);
    setText(next); setTagQuery(null);
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(before.length, before.length); });
  };
  // Show @names in a message as highlighted tags.
  const renderBody = (m: Msg) => {
    const body = m.body ?? "";
    const tagNames = [...(m.mentions ?? []).map((id) => names.get(id)?.name).filter((x): x is string => !!x), ...(m.mention_all ? ["all"] : [])];
    if (!tagNames.length) return body;
    const esc = tagNames.sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const parts = body.split(new RegExp(`(@(?:${esc.join("|")}))`, "g"));
    return parts.map((p, i) => (i % 2 ? <span key={i} className={`chat-tag ${p === `@${me.name}` || p === "@all" ? "self" : ""}`}>{p}</span> : p));
  };

  const room = rooms.find((r) => r.id === active);
  const names = new Map((info?.members ?? []).map((m) => [m.id, m]));
  const group = info?.kind === "GROUP";
  // Read receipts (v0.55, CHRIS Nov 26): each person is shown under the last message they've read.
  // Chats of 3 or more: "Read by Ana, Bea, Cy". 1-on-1: "Read 3:58 AM" (when they opened it).
  const manyMembers = (info?.members.length ?? 0) >= 3;
  const readAt = new Map<string, Member[]>();
  for (const mem of info?.members ?? []) {
    if (mem.id === me.id || !mem.last_read_at) continue;
    let at: Msg | undefined;
    for (let k = msgs.length - 1; k >= 0; k--) { if (msgs[k].created_at <= mem.last_read_at) { at = msgs[k]; break; } }
    if (!at || at.sender_id === mem.id) continue; // they sent it: no need to say they read it
    readAt.set(at.id, [...(readAt.get(at.id) ?? []), mem]);
  }
  const readLabel = (list: Member[]) => {
    if (!manyMembers) {
      const t = new Date(list[0].last_read_at);
      const sameDay = t.toDateString() === new Date().toDateString();
      return `Read ${t.toLocaleString("en-PH", { timeZone: "Asia/Manila", ...(sameDay ? {} : { month: "short", day: "numeric" }), hour: "numeric", minute: "2-digit" })}`;
    }
    const first = list.map((x) => (names.get(x.id)?.name ?? x.name).split(" ")[0]);
    return `Read by ${first.length > 6 ? `${first.slice(0, 5).join(", ")} and ${first.length - 5} others` : first.join(", ")}`;
  };

  return (
    <div className={`chat-wrap ${active ? "room-open" : ""}`}>
      <aside className="chat-list" aria-label="Chats">
        <div className="chat-list-head">
          <h1>Chat</h1>
          <button type="button" className="icon-btn chat-sound" aria-pressed={sounds} title={sounds ? "Chat sounds are on. Tap to mute." : "Chat sounds are off. Tap to turn on."}
            aria-label={sounds ? "Mute chat sounds" : "Turn on chat sounds"} onClick={() => setSoundsOn(!sounds)}>{sounds ? <IconBell /> : <IconBellSlash />}</button>
          <button type="button" className="secondary chat-new" onClick={() => setPanel(panel === "new" ? null : "new")}><IconPlus /> New</button>
        </div>
        {panel === "new" && <NewChat people={people} supabase={supabase} onDone={async (id) => { await refreshList(); open(id); }} onClose={() => setPanel(null)} />}
        <ul className="chat-rooms">
          {rooms.map((r) => (
            <li key={r.id}>
              <button type="button" className={`chat-room-btn ${r.id === active ? "on" : ""} ${r.unread ? "unread" : ""} ${r.mgmt_unread ? "mgmt" : ""}`} onClick={() => open(r.id)}>
                <RoomFace r={r} name={r.name} icon={r.icon_path ? photos[r.icon_path] : undefined} size={44} />
                <span className="chat-room-text">
                  <span className="chat-room-top"><strong>{r.name ?? "Chat"}</strong>{r.last && <span className="chat-time">{listTime(r.last_at)}</span>}</span>
                  <span className="chat-room-last">
                    <span>{r.last ? `${r.last.mine ? "You: " : r.kind === "GROUP" ? `${r.last.sender.split(" ")[0]}: ` : ""}${r.last.text}` : r.kind === "GROUP" ? `${r.members} people` : "Say hi"}</span>
                    {!!r.mgmt_unread && <span className="mgmt-chip">{r.mgmt_from ? `Message from ${r.mgmt_from}` : "Management"}</span>}
                    {!!r.mention_unread && <span className="chat-at" title="You were tagged">@</span>}
                    {r.unread > 0 && <span className="nav-badge">{r.unread > 99 ? "99+" : r.unread}</span>}
                  </span>
                </span>
              </button>
            </li>
          ))}
          {rooms.length === 0 && <li className="muted small chat-empty">No chats yet. Tap New to message someone.</li>}
        </ul>
      </aside>

      <section className="chat-pane" aria-label={info?.name ?? "Conversation"}>
        {!active ? (
          <div className="chat-blank muted"><p>Pick a chat, or tap <strong>New</strong> to message someone or start a group.</p><p className="small">Chats are private: only the people in a chat can read it.</p></div>
        ) : (
          <>
            <header className="chat-head">
              <button type="button" className="icon-btn chat-back" aria-label="Back to chats" onClick={() => open(null)}><IconBack /></button>
              {room ? <RoomFace r={room} name={info?.name ?? room.name} icon={room.icon_path ? photos[room.icon_path] : undefined} size={36} />
                : <span className="chat-group-face small" aria-hidden>{(info?.name ?? "?").slice(0, 1).toUpperCase()}</span>}
              <span className="chat-head-text"><strong>{info?.name ?? room?.name ?? "Chat"}</strong>{group && <span className="small muted">{info?.members.length} people</span>}</span>
              {info && <button type="button" className="icon-btn" aria-label={group ? "Group details" : "Chat details"} title={group ? "Group details" : "Chat details"} onClick={() => setPanel(panel === "info" ? null : "info")}><IconInfo /></button>}
            </header>
            {panel === "info" && info && <GroupInfo key={info.id} info={info} me={me.id} icon={room?.icon_path ?? null} canAdd={info.kind === "GROUP" && (!info.auto || management)} canIcon={management} people={people} supabase={supabase}
              onCleared={() => { setMsgs([]); setPanel(null); void refreshList(); }}
              onChanged={async (left) => { if (left) { await refreshList(); open(null); return; } const { data } = await supabase.rpc("chat_room", { p_room: info.id }); if (data?.ok) setInfo(data as RoomInfo); void refreshList(); }} />}
            <div className="chat-scroll" ref={scroller} onClick={() => { setPicked(null); setPicker((p) => (p && typeof p === "object" ? null : p)); }}>
              {more && <p className="chat-older"><button type="button" className="link-like small" onClick={older}>Load older messages</button></p>}
              {loading && <p className="muted small chat-older">Loading…</p>}
              {msgs.map((m, i) => {
                const prev = msgs[i - 1];
                const newDay = !prev || dayKey(prev.created_at) !== dayKey(m.created_at);
                const mine = m.sender_id === me.id;
                const first = newDay || !prev || prev.sender_id !== m.sender_id || Date.parse(m.created_at) - Date.parse(prev.created_at) > 5 * 60000;
                const who = names.get(m.sender_id);
                const next = msgs[i + 1];
                const last = !next || next.sender_id !== m.sender_id || dayKey(next.created_at) !== dayKey(m.created_at) || Date.parse(next.created_at) - Date.parse(m.created_at) > 5 * 60000;
                return (
                  <div key={m.id} id={`msg-${m.id}`}>
                    {newDay && <div className="chat-day"><span>{dayLabel(m.created_at)}</span></div>}
                    <div className={`chat-msg ${mine ? "mine" : ""} ${first ? "first" : ""} ${picked === m.id ? "picked" : ""} ${m.from_management && !m.deleted_at ? "mgmt" : ""} ${!mine && !m.deleted_at && (m.mention_all || m.mentions?.includes(me.id)) ? "tagged" : ""}`}>
                      {!mine && group && (first ? <Avatar name={who?.name ?? "?"} url={faces.get(m.sender_id) ?? null} size={30} /> : <span className="chat-face-gap" />)}
                      <div className="chat-bubble-wrap">
                        {!mine && group && first && <span className="chat-name">{who?.name ?? "Former member"}</span>}
                        {!mine && m.from_management && !m.deleted_at && <span className="mgmt-chip"><IconMegaphone className="ic-lead" />Message from {firstName(who?.name ?? "management")}</span>}
                        <div className={`chat-bubble ${m.deleted_at ? "deleted" : ""} ${m.photo_path && !m.body ? "photo-only" : ""}`}
                          onClick={(e) => {
                            if (m.deleted_at) return;
                            e.stopPropagation(); setPicker(null);
                            const now = Date.now(), prev = lastTap.current;
                            lastTap.current = { id: m.id, t: now };
                            // Double-tap: heart it (never takes a heart away), like Messenger and Instagram.
                            if (prev && prev.id === m.id && now - prev.t < 350) {
                              lastTap.current = null; setPicked(null);
                              if (!reactions.some((r) => r.message_id === m.id && r.user_id === me.id && r.emoji === "❤️")) void react(m.id, "❤️");
                              return;
                            }
                            setPicked(picked === m.id ? null : m.id);
                          }} title={time(m.created_at)}>
                          {m.deleted_at ? (management && deleted[m.id] ? <DeletedView d={deleted[m.id]} photo={deleted[m.id].photo_path ? photos[deleted[m.id].photo_path!] : undefined} /> : <em>Message deleted</em>) : (
                            <>
                              {m.reply_to !== undefined && m.reply_to !== null && (() => {
                                const q = msgs.find((x) => x.id === m.reply_to);
                                return (
                                  <button type="button" className="chat-quote" onClick={(e) => { e.stopPropagation(); document.getElementById(`msg-${m.reply_to}`)?.scrollIntoView({ behavior: "smooth", block: "center" }); }}>
                                    <strong>{q ? (q.sender_id === me.id ? "You" : names.get(q.sender_id)?.name ?? "Former member") : "Earlier message"}</strong>
                                    <span>{!q ? "Scroll up to see it" : q.deleted_at ? "Message deleted" : q.body ? q.body.slice(0, 120) : q.gif_url ? "GIF" : "Photo"}</span>
                                  </button>
                                );
                              })()}
                              {m.photo_path && (photos[m.photo_path]
                                // eslint-disable-next-line @next/next/no-img-element
                                ? <img src={photos[m.photo_path]} alt="Photo" className="chat-photo zoomable" onClick={(e) => { e.stopPropagation(); viewPhoto(photos[m.photo_path!]); }} />
                                : <span className="chat-photo loading">Photo</span>)}
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              {m.gif_url && <img src={m.gif_url} alt="GIF" className="chat-photo zoomable" onClick={(e) => { e.stopPropagation(); viewPhoto(m.gif_url!, "GIF"); }} />}
                              {m.body && <span className="chat-text">{renderBody(m)}</span>}
                            </>
                          )}
                        </div>
                        {!m.deleted_at && <Reactions list={reactions.filter((r) => r.message_id === m.id)} me={me.id} names={names} onToggle={(e) => void react(m.id, e)} />}
                        {picked === m.id && !m.deleted_at && (
                          <div className="chat-react-bar" role="toolbar" aria-label="React" onClick={(e) => e.stopPropagation()}>
                            {QUICK.map((e) => <button key={e} type="button" aria-label={`React ${e}`} onClick={() => void react(m.id, e)}>{e}</button>)}
                            <button type="button" className="more" aria-label="More emoji" onClick={() => setPicker({ react: m.id })}>＋</button>
                            <button type="button" className="chat-reply-btn" aria-label="Reply" title="Reply" onClick={() => { setReplyTo(m); setPicked(null); box.current?.focus(); }}>↩ Reply</button>
                          </div>
                        )}
                        {typeof picker === "object" && picker?.react === m.id && <EmojiGrid onPick={(e) => void react(m.id, e)} onClose={() => setPicker(null)} />}
                        <span className={`chat-meta ${last ? "" : "quiet"} ${picked === m.id ? "show" : ""}`}>
                          {time(m.created_at)}
                          {mine && !m.deleted_at && <button type="button" className={`link-like chat-del ${picked === m.id ? "show" : ""}`} onClick={(e) => { e.stopPropagation(); void remove(m); }}>Delete</button>}
                        </span>
                        {readAt.has(m.id) && (
                          <span className="chat-seen" title={readAt.get(m.id)!.map((x) => x.name).join(", ")}>{readLabel(readAt.get(m.id)!)}</span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
              {!loading && msgs.length === 0 && !error && <p className="muted small chat-older">No messages yet. Say hi!</p>}
            </div>
            {error && <p className="chat-error small" role="alert">{error}</p>}
            {replyTo && (
              <div className="chat-replying">
                <span><span className="muted small">Replying to {replyTo.sender_id === me.id ? "yourself" : names.get(replyTo.sender_id)?.name ?? "Former member"}</span>
                  <span className="chat-replying-text">{replyTo.body ? replyTo.body.slice(0, 120) : replyTo.gif_url ? "GIF" : "Photo"}</span></span>
                <button type="button" className="icon-btn" aria-label="Cancel reply" onClick={() => setReplyTo(null)}><IconX size={18} /></button>
              </div>
            )}
            <form className="chat-compose" onSubmit={(e) => { e.preventDefault(); void send(); }}>
              <input ref={fileInput} type="file" accept="image/*" hidden onChange={(e) => void sendPhoto(e.target.files?.[0])} />
              <button type="button" className="icon-btn" aria-label="Send a photo" title="Send a photo" disabled={busy} onClick={() => fileInput.current?.click()}><IconImage /></button>
              <button type="button" className={`icon-btn chat-gif-btn ${picker === "gif" ? "on" : ""}`} aria-label="Send a GIF" title="Send a GIF" disabled={busy} onClick={() => setPicker(picker === "gif" ? null : "gif")}>GIF</button>
              <button type="button" className={`icon-btn chat-emoji-btn ${picker === "emoji" ? "on" : ""}`} aria-label="Add an emoji" title="Add an emoji" onClick={() => setPicker(picker === "emoji" ? null : "emoji")}>🙂</button>
              {picker === "emoji" && <EmojiGrid onPick={insertEmoji} onClose={() => setPicker(null)} composer />}
              {picker === "gif" && <GifPicker onPick={(url) => void send(undefined, url)} onClose={() => setPicker(null)} />}
              {tagOptions.length > 0 && (
                <ul className="chat-tags-pop" role="listbox" aria-label="Tag someone">
                  {tagOptions.map((o, i) => (
                    <li key={o.id}><button type="button" role="option" aria-selected={i === tagIndex} className={i === tagIndex ? "on" : undefined}
                      onMouseDown={(e) => { e.preventDefault(); pickTag(o); }}>
                      {o.id === "all" ? <><strong>@all</strong> <span className="muted small">tag everyone in this group</span></> : <><Avatar name={o.name} url={faces.get(o.id) ?? null} size={24} /> {o.name}</>}
                    </button></li>
                  ))}
                </ul>
              )}
              <textarea ref={box} value={text} rows={1} maxLength={4000} placeholder={group ? "Message · type @ to tag" : "Message"} aria-label="Message"
                onChange={(e) => onType(e.target.value, e.target.selectionStart ?? e.target.value.length)}
                onBlur={() => setTimeout(() => setTagQuery(null), 150)}
                onPaste={(e) => { const f = [...e.clipboardData.files].find((x) => x.type.startsWith("image/")); if (f) { e.preventDefault(); void sendPhoto(f); } }}
                onKeyDown={(e) => {
                  if (tagOptions.length) {
                    if (e.key === "ArrowDown") { e.preventDefault(); setTagIndex((i) => (i + 1) % tagOptions.length); return; }
                    if (e.key === "ArrowUp") { e.preventDefault(); setTagIndex((i) => (i - 1 + tagOptions.length) % tagOptions.length); return; }
                    if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pickTag(tagOptions[Math.min(tagIndex, tagOptions.length - 1)]); return; }
                    if (e.key === "Escape") { setTagQuery(null); return; }
                  }
                  if (e.key === "Enter" && !e.shiftKey && !("ontouchstart" in window)) { e.preventDefault(); void send(); }
                }} />
              <button type="submit" className="chat-send" aria-label="Send" disabled={busy || !text.trim()}><IconSend /></button>
            </form>
          </>
        )}
      </section>
    </div>
  );
}

type Sb = ReturnType<typeof createClient>;

/** A deleted message as owners and the GM see it: crossed out (update-0052). */
function DeletedView({ d, photo }: { d: Deleted; photo?: string }) {
  return (
    <span className="chat-deleted-shown">
      <span className="chat-deleted-label">Deleted by sender · only owners and the GM see this</span>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {d.photo_path && (photo ? <img src={photo} alt="Deleted photo" className="chat-photo" /> : <span className="chat-photo loading">Photo</span>)}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {d.gif_url && <img src={d.gif_url} alt="Deleted GIF" className="chat-photo" />}
      {d.body && <s className="chat-text">{d.body}</s>}
    </span>
  );
}

/** Reactions under a message: one chip per emoji with a count; yours are highlighted, tap to add or take back. */
function Reactions({ list, me, names, onToggle }: { list: Reaction[]; me: string; names: Map<string, { name: string }>; onToggle: (emoji: string) => void }) {
  if (!list.length) return null;
  const groups = new Map<string, Reaction[]>();
  for (const r of list) groups.set(r.emoji, [...(groups.get(r.emoji) ?? []), r]);
  return (
    <span className="chat-reactions">
      {[...groups].map(([e, rs]) => {
        const who = rs.map((r) => (r.user_id === me ? "You" : names.get(r.user_id)?.name.split(" ")[0] ?? "Someone")).join(", ");
        return (
          <button key={e} type="button" className={`chat-reaction ${rs.some((r) => r.user_id === me) ? "mine" : ""}`} title={who} aria-label={`${e} ${who}`}
            onClick={(ev) => { ev.stopPropagation(); onToggle(e); }}>{e}{rs.length > 1 && <span>{rs.length}</span>}</button>
        );
      })}
    </span>
  );
}

function EmojiGrid({ onPick, onClose, composer = false }: { onPick: (e: string) => void; onClose: () => void; composer?: boolean }) {
  return (
    <div className={`chat-pop chat-emoji ${composer ? "composer" : ""}`} role="dialog" aria-label="Emoji" onClick={(e) => e.stopPropagation()}>
      <div className="chat-pop-head"><span className="small muted">Emoji</span><button type="button" className="link-like small" onClick={onClose}>Close</button></div>
      <div className="chat-emoji-grid">{EMOJI.map((e) => <button key={e} type="button" onClick={() => onPick(e)}>{e}</button>)}</div>
    </div>
  );
}

export function GifPicker({ onPick, onClose }: { onPick: (url: string) => void; onClose: () => void }) {
  // Messenger-style sheet (CHRIS Nov 26): search + Done on top, trending first, 3 masonry columns in each GIF's own shape.
  const [q, setQ] = useState("");
  const [gifs, setGifs] = useState<Gif[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [more, setMore] = useState(true);
  const loading = useRef(false);
  const load = async (query: string, offset: number) => {
    if (loading.current) return;
    loading.current = true;
    try {
      const res = await fetch(`/api/gif?q=${encodeURIComponent(query.trim())}&offset=${offset}`);
      const body = (await res.json()) as { ok: boolean; error?: string; gifs?: Gif[] };
      if (!body.ok) { setErr(body.error === "NO_KEY" ? "GIFs turn on once the owner adds the GIPHY key." : "GIFs aren't loading right now. Try again."); setGifs((g) => g ?? []); return; }
      const got = body.gifs ?? [];
      setErr(null); setMore(got.length > 0);
      setGifs((g) => { const list = offset ? [...(g ?? []), ...got] : got; return list.filter((x, k) => list.findIndex((y) => y.id === x.id) === k); });
    } catch { setErr("GIFs aren't loading right now. Try again."); setGifs((g) => g ?? []); }
    finally { loading.current = false; }
  };
  useEffect(() => {
    let gone = false;
    const t = setTimeout(() => { if (!gone) { setGifs(null); void load(q, 0); } }, q ? 350 : 0);
    return () => { gone = true; clearTimeout(t); };
  }, [q]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  // Three columns, each GIF added to the shortest one so the grid stays even.
  const cols: Gif[][] = [[], [], []];
  const heights = [0, 0, 0];
  for (const g of gifs ?? []) { const c = heights.indexOf(Math.min(...heights)); cols[c].push(g); heights[c] += (g.h || 200) / (g.w || 200); }
  return (
    <>
      <div className="chat-gif-backdrop" onClick={onClose} aria-hidden />
      <div className="chat-pop chat-gifs" role="dialog" aria-label="GIFs">
        <div className="chat-gif-handle" aria-hidden />
        <div className="chat-gif-head">
          <label className="chat-gif-search">
            <IconSearch />
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search GIPHY" aria-label="Search GIFs" autoFocus={typeof window !== "undefined" && window.innerWidth > 900} />
          </label>
          <button type="button" className="chat-gif-done" onClick={onClose}>Done</button>
        </div>
        <div className="chat-gif-scroll" onScroll={(e) => {
          const el = e.currentTarget;
          if (more && gifs?.length && el.scrollTop + el.clientHeight > el.scrollHeight - 300) void load(q, gifs.length);
        }}>
          {err && <p className="small muted">{err}</p>}
          {gifs === null && <p className="small muted chat-gif-wait">Loading…</p>}
          {gifs && gifs.length === 0 && !err && <p className="small muted chat-gif-wait">No GIFs found. Try another word.</p>}
          <div className="chat-gif-masonry">
            {cols.map((col, c) => (
              <div key={c} className="chat-gif-col">
                {col.map((g) => (
                  <button key={g.id} type="button" onClick={() => onPick(g.url)} title={g.title} style={{ aspectRatio: `${g.w || 200} / ${g.h || 200}` }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={g.preview} alt={g.title} loading="lazy" />
                  </button>
                ))}
              </div>
            ))}
          </div>
          <p className="chat-giphy small muted">Powered by GIPHY</p>
        </div>
      </div>
    </>
  );
}

function PeoplePicker({ people, chosen, toggle, filter }: { people: ChatPerson[]; chosen: Set<string>; toggle: (id: string) => void; filter: string }) {
  const q = filter.trim().toLowerCase();
  const list = people.filter((p) => !q || p.name.toLowerCase().includes(q));
  return (
    <ul className="chat-people">
      {list.map((p) => (
        <li key={p.id}><label><input type="checkbox" checked={chosen.has(p.id)} onChange={() => toggle(p.id)} /><Avatar name={p.name} url={p.photo_url} size={30} /> {p.name}</label></li>
      ))}
      {list.length === 0 && <li className="muted small">Nobody matches.</li>}
    </ul>
  );
}

function NewChat({ people, supabase, onDone, onClose }: { people: ChatPerson[]; supabase: Sb; onDone: (id: string) => void; onClose: () => void }) {
  const [mode, setMode] = useState<"dm" | "group">("dm");
  const [q, setQ] = useState("");
  const [name, setName] = useState("");
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);
  const toggle = (id: string) => setChosen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const dm = async (id: string) => {
    const { data } = await supabase.rpc("chat_start_dm", { p_user: id });
    if (data?.ok) onDone(data.id); else setErr(ERR[data?.error] ?? "Couldn't start the chat.");
  };
  const create = async () => {
    const { data } = await supabase.rpc("chat_create_group", { p_name: name, p_members: [...chosen] });
    if (data?.ok) onDone(data.id); else setErr(ERR[data?.error] ?? "Couldn't make the group.");
  };
  const ql = q.trim().toLowerCase();
  return (
    <div className="chat-panel">
      <div className="segmented chat-mode">
        <button type="button" className={mode === "dm" ? "on" : undefined} onClick={() => setMode("dm")}>Message someone</button>
        <button type="button" className={mode === "group" ? "on" : undefined} onClick={() => setMode("group")}>New group</button>
      </div>
      {mode === "group" && <input value={name} maxLength={60} placeholder="Group name" aria-label="Group name" onChange={(e) => setName(e.target.value)} />}
      <input value={q} placeholder="Search names" aria-label="Search names" onChange={(e) => setQ(e.target.value)} />
      {mode === "dm" ? (
        <ul className="chat-people">
          {people.filter((p) => !ql || p.name.toLowerCase().includes(ql)).map((p) => (
            <li key={p.id}><button type="button" className="link-like chat-person" onClick={() => void dm(p.id)}><Avatar name={p.name} url={p.photo_url} size={30} /> {p.name}</button></li>
          ))}
        </ul>
      ) : <PeoplePicker people={people} chosen={chosen} toggle={toggle} filter={q} />}
      {err && <p className="chat-error small">{err}</p>}
      <div className="chat-panel-actions">
        <button type="button" className="secondary" onClick={onClose}>Cancel</button>
        {mode === "group" && <button type="button" disabled={!name.trim() || chosen.size === 0} onClick={() => void create()}>Create group ({chosen.size + 1})</button>}
      </div>
    </div>
  );
}

/** A chat's picture: 1-on-1 = the other person's photo; group = its photo, else the Hermosa logo. */
function RoomFace({ r, name, icon, size }: { r: ChatRoomRow; name: string | null; icon?: string; size: number }) {
  if (r.kind === "DM") return <Avatar name={name ?? "?"} url={r.photo_url} size={size} />;
  const cls = `chat-group-face ${size < 40 ? "small" : ""}`;
  // eslint-disable-next-line @next/next/no-img-element
  if (r.icon_path) return icon ? <img className={`${cls} chat-icon`} src={icon} alt="" /> : <span className={cls} aria-hidden />;
  // Every group starts with the Hermosa logo until owners or the GM give it a photo (CHRIS, Nov 26).
  // eslint-disable-next-line @next/next/no-img-element
  return <img className={`${cls} chat-icon chat-logo`} src="/hermosa-logo.png" alt="" />;
}

/** Group icons are small: centre-crop to a 512px square JPEG. */
async function squareIcon(file: File): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = url; });
    const side = Math.min(img.naturalWidth, img.naturalHeight), out = Math.min(512, side);
    const c = document.createElement("canvas");
    c.width = out; c.height = out;
    c.getContext("2d")!.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, out, out);
    return await new Promise<Blob>((ok, bad) => c.toBlob((b) => (b ? ok(b) : bad(new Error("photo"))), "image/jpeg", 0.85));
  } finally { URL.revokeObjectURL(url); }
}

function GroupInfo({ info, me, icon, canAdd, canIcon, people, supabase, onChanged, onCleared }: { info: RoomInfo; me: string; icon: string | null; canAdd: boolean; canIcon: boolean; people: ChatPerson[]; supabase: Sb; onChanged: (left: boolean) => void; onCleared: () => void }) {
  const [name, setName] = useState(info.name);
  const [canDelete, setCanDelete] = useState(false);
  useEffect(() => { void supabase.rpc("chat_can_delete", { p_room: info.id }).then(({ data }) => setCanDelete(data === true)); }, [supabase, info.id]);
  const group = info.kind === "GROUP";
  // Delete the conversation for everyone (update-0050). Photos are removed from the private folder first.
  const wipe = async () => {
    const ask = info.auto ? "Clear ALL messages in this group for everyone? This can't be undone." : "Delete this conversation for everyone in it, with all its messages and photos? This can't be undone.";
    if (!confirm(ask)) return;
    const { data: ph } = await supabase.from("chat_messages").select("photo_path").eq("room_id", info.id).not("photo_path", "is", null);
    const paths = ((ph ?? []) as { photo_path: string }[]).map((x) => x.photo_path);
    for (let i = 0; i < paths.length; i += 100) await supabase.storage.from("chat").remove(paths.slice(i, i + 100));
    const { data } = await supabase.rpc("chat_delete_room", { p_room: info.id });
    if (!data?.ok) { setErr(ERR[data?.error] ?? "Couldn't delete it."); return; }
    if (data.cleared) onCleared(); else onChanged(true);
  };
  const [adding, setAdding] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);
  const inGroup = new Set(info.members.map((m) => m.id));
  const iconInput = useRef<HTMLInputElement>(null);
  const [iconBusy, setIconBusy] = useState(false);
  // Group icon (update-0058): upload to <room>/<me>/, then point the group at it; tidy up our own old file.
  const setIcon = async (file: File | null) => {
    setErr(null); setIconBusy(true);
    try {
      let path: string | null = null;
      if (file) {
        if (!file.type.startsWith("image/")) { setErr("Pick a photo."); return; }
        path = `${info.id}/${me}/icon-${uuid()}.jpg`;
        const { error: e } = await supabase.storage.from("chat").upload(path, await squareIcon(file), { contentType: "image/jpeg" });
        if (e) { setErr("The photo didn't upload. Try again."); return; }
      }
      const { data, error: e } = await supabase.rpc("chat_set_icon", { p_room: info.id, p_path: path });
      if (e || !data?.ok) { setErr(e?.code === "PGRST202" ? "Group photos need database update-0058." : ERR[data?.error] ?? "That didn't work."); return; }
      if (data.old && String(data.old).startsWith(`${info.id}/${me}/`)) void supabase.storage.from("chat").remove([data.old]);
      onChanged(false);
    } catch { setErr("The photo didn't upload. Try again."); } finally {
      setIconBusy(false);
      if (iconInput.current) iconInput.current.value = "";
    }
  };
  const call = async (fn: string, args: Record<string, unknown>, left = false) => {
    const { data } = await supabase.rpc(fn, args);
    if (data?.ok) { setAdding(false); setChosen(new Set()); onChanged(left); } else setErr(ERR[data?.error] ?? "That didn't work.");
  };
  return (
    <div className="chat-panel chat-info">
      {!group ? null : info.auto ? <p className="small muted">Everyone is in this group automatically: staff join and leave it with their home branch. Messages wait here for people who are offline.</p> : (
        <form className="chat-rename" onSubmit={(e) => { e.preventDefault(); void call("chat_rename", { p_room: info.id, p_name: name }); }}>
          <input value={name} maxLength={60} aria-label="Group name" onChange={(e) => setName(e.target.value)} />
          <button type="submit" className="secondary" disabled={!name.trim() || name.trim() === info.name}>Rename</button>
        </form>
      )}
      {group && canIcon && (
        <div className="chat-panel-actions chat-icon-row">
          <input ref={iconInput} type="file" accept="image/*" hidden onChange={(e) => void setIcon(e.target.files?.[0] ?? null)} />
          <button type="button" className="secondary" disabled={iconBusy} onClick={() => iconInput.current?.click()}>{iconBusy ? "Saving…" : icon ? "Change group photo" : "Add group photo"}</button>
          {icon && <button type="button" className="secondary" disabled={iconBusy} onClick={() => void setIcon(null)}>Remove photo</button>}
        </div>
      )}
      <ul className="chat-people">
        {info.members.map((m) => <li key={m.id}><span><Avatar name={m.name} url={people.find((p) => p.id === m.id)?.photo_url ?? null} size={28} /> {m.name}{m.id === me ? " (you)" : ""}</span></li>)}
      </ul>
      {canAdd && adding && (
        <>
          <PeoplePicker people={people.filter((p) => !inGroup.has(p.id))} chosen={chosen} toggle={(id) => setChosen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; })} filter="" />
          <div className="chat-panel-actions">
            <button type="button" className="secondary" onClick={() => setAdding(false)}>Cancel</button>
            <button type="button" disabled={!chosen.size} onClick={() => void call("chat_add_members", { p_room: info.id, p_members: [...chosen] })}>Add {chosen.size || ""}</button>
          </div>
        </>
      )}
      {!adding && group && (canAdd || !info.auto) && (
        <div className="chat-panel-actions">
          {!info.auto && <button type="button" className="secondary" onClick={() => { if (confirm("Leave this group? You won't see its messages anymore.")) void call("chat_leave", { p_room: info.id }, true); }}>Leave group</button>}
          {canAdd && <button type="button" onClick={() => setAdding(true)}>Add people</button>}
        </div>
      )}
      {canDelete && !adding && (
        <div className="chat-panel-actions chat-danger">
          <button type="button" className="secondary danger" onClick={() => void wipe()}>{info.auto ? "Clear all messages" : "Delete conversation"}</button>
        </div>
      )}
      {err && <p className="chat-error small">{err}</p>}
    </div>
  );
}
