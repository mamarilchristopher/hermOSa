"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { OPEN_CHAT_EVENT } from "./ChatDock";
import { createClient } from "@/lib/supabase/browser";
import { Avatar } from "./Avatar";

type Person = { id?: string; name: string; last_seen: string; photo?: string | null; owner?: boolean };

/**
 * Checks this person in every 45 seconds while the app is open in a tab (even a background tab). Everyone sees a strip on every
 * page: "Online now" with each person's profile picture, owners first (update-0037), refreshed every 30 seconds.
 */
export function OnlineNow({ show }: { show: boolean }) {
  const supabase = useMemo(() => createClient(), []);
  const [people, setPeople] = useState<Person[] | null>(null);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const router = useRouter();
  // Tap a person to chat with them (CHRIS Nov 26): opens the chat window, or the Chat page when there's no chat window here.
  const chat = async (id: string) => {
    const { data } = await supabase.rpc("chat_start_dm", { p_user: id });
    const room = (data as { ok?: boolean; id?: string } | null)?.ok ? (data as { id: string }).id : null;
    if (!room) return;
    const detail = { room, handled: false };
    window.dispatchEvent(new CustomEvent(OPEN_CHAT_EVENT, { detail }));
    if (!detail.handled) router.push(`/chat/${room}`);
  };

  useEffect(() => {
    let stop = false;
    const signed = new Map<string, string>();
    const visible = () => document.visibilityState === "visible";
    const touch = () => { supabase.rpc("touch_presence").then(() => undefined, () => undefined); };
    const load = async () => {
      if (!show || !visible()) return;
      const { data, error } = await supabase.rpc("online_now");
      if (stop || error || !Array.isArray(data)) return;
      const list = data as Person[];
      setPeople(list);
      // Signed photo links last an hour; fetch only the ones not loaded yet.
      const need = [...new Set(list.map((p) => p.photo).filter((x): x is string => !!x && !signed.has(x)))];
      if (need.length) {
        const { data: s } = await supabase.storage.from("profile-photos").createSignedUrls(need, 3600);
        for (const r of s ?? []) if (r.path && r.signedUrl) signed.set(r.path, r.signedUrl);
        if (!stop) setUrls(Object.fromEntries(signed));
      }
    };
    touch(); load();
    const a = setInterval(touch, 45_000);
    const b = setInterval(load, 30_000);
    const onVis = () => { if (visible()) { touch(); load(); } };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);
    return () => { stop = true; clearInterval(a); clearInterval(b); document.removeEventListener("visibilitychange", onVis); window.removeEventListener("focus", onVis); };
  }, [supabase, show]);

  if (!show || people === null) return null;
  return (
    <span className="online-now" role="status" aria-live="polite">
      <span className={`online-dot ${people.length ? "on" : ""}`} aria-hidden />
      <strong>Online now:</strong>
      {people.length === 0 ? <span className="muted">none</span> : people.map((p, i) => (
        p.id ? (
          <button type="button" key={p.id} className={`online-name online-chat ${p.owner ? "owner" : ""}`} title={`Chat with ${p.name}`} onClick={() => void chat(p.id!)}>
            <Avatar name={p.name} url={p.photo ? urls[p.photo] : null} size={22} />{p.name}
          </button>
        ) : (
        <span key={`${p.name}-${i}`} className={`online-name ${p.owner ? "owner" : ""}`} title={p.owner ? `${p.name} (owner)` : p.name}>
          <Avatar name={p.name} url={p.photo ? urls[p.photo] : null} size={22} />{p.name}
        </span>
        )
      ))}
    </span>
  );
}
