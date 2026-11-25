"use server";
import { revalidatePath } from "next/cache";
import { requireAccess } from "@/lib/access";
import { manilaToday } from "@/lib/dates";
import { loadTodos, type Todo } from "@/lib/todos";
import { noticeButton, noticeHref } from "@/lib/noticeLink";

export type InboxNotice = { id: string; title: string; body: string | null; at: string; href: string | null; button: string; read: boolean };
export type Inbox = { todos: Todo[]; notices: InboxNotice[] };

/** The bell (CHRIS Nov 25): this person's to-dos and latest notices, loaded after the page shows. */
export async function loadInbox(): Promise<Inbox> {
  const { supabase, access, branches } = await requireAccess();
  const [todos, { data }] = await Promise.all([
    loadTodos(supabase, access, manilaToday()).catch((e) => { console.error("loadTodos", e); return [] as Todo[]; }),
    supabase.from("notifications").select("id, kind, title, body, link, created_at, read_at").order("created_at", { ascending: false }).limit(20),
  ]);
  const notices = ((data ?? []) as { id: string; kind?: string; title: string; body: string | null; link: string | null; created_at: string; read_at: string | null }[])
    .map((n) => ({ id: n.id, title: n.title, body: n.body, at: n.created_at, href: n.link ? noticeHref(n.link, n.body, branches) ?? n.link : null, button: noticeButton(n.kind), read: !!n.read_at }));
  return { todos, notices };
}

/** Mark notices read: one (opened from the bell) or all. */
export async function markRead(ids: string[] | null): Promise<void> {
  const { supabase } = await requireAccess();
  await supabase.rpc("mark_notifications_read", { p_ids: ids });
  revalidatePath("/", "layout");
}
