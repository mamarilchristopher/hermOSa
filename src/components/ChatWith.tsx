"use client";
// Tap a person to chat with them (CHRIS Nov 26): Online now and the On duty faces.
// Opens the chat window here (ChatDock), or the Chat page when there's no chat window on this page.
import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/browser";
import { OPEN_CHAT_EVENT } from "./ChatDock";

export function useChatWith() {
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();
  return async (user: string) => {
    const { data } = await supabase.rpc("chat_start_dm", { p_user: user });
    const room = (data as { ok?: boolean; id?: string } | null)?.ok ? (data as { id: string }).id : null;
    if (!room) return;
    const detail = { room, handled: false };
    window.dispatchEvent(new CustomEvent(OPEN_CHAT_EVENT, { detail }));
    if (!detail.handled) router.push(`/chat/${room}`);
  };
}

/** Wraps a face so tapping it opens a chat with that person. */
export function ChatWith({ user, name, children }: { user: string; name: string; children: React.ReactNode }) {
  const chat = useChatWith();
  return <button type="button" className="chat-with" title={`Chat with ${name}`} aria-label={`Chat with ${name}`} onClick={() => void chat(user)}>{children}</button>;
}
