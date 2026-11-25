import { can, requireAccess } from "@/lib/access";
import { TopBar } from "@/components/TopBar";
import { photoUrls } from "@/lib/photos";
import { ChatApp, type ChatPerson, type ChatRoomRow } from "../ChatApp";

/** Team chat (v0.49, update-0049): private 1-on-1 and group chats. Only the people in a chat can read it. */
export default async function ChatPage({ params }: { params: Promise<{ room?: string[] }> }) {
  const { room } = await params;
  const { supabase, access } = await requireAccess();
  const [{ data: list, error }, { data: ppl }, { data: meRow }] = await Promise.all([
    supabase.rpc("chat_list"),
    supabase.rpc("chat_people"),
    supabase.from("app_users").select("photo_path").eq("id", access.user_id).maybeSingle(),
  ]);
  const rooms = (Array.isArray(list) ? list : []) as ChatRoomRow[];
  const people = (Array.isArray(ppl) ? ppl : []) as ChatPerson[];
  const myPhoto = (meRow as { photo_path?: string | null } | null)?.photo_path ?? null;
  const urls = await photoUrls(supabase, [...people.map((p) => p.photo_path), ...rooms.map((r) => r.photo_path), myPhoto]);
  const withUrl = <T extends { photo_path?: string | null }>(x: T) => ({ ...x, photo_url: x.photo_path ? urls.get(x.photo_path) ?? null : null });
  return (
    <>
      <TopBar access={access} />
      <main className="chat-main">
        {error ? (
          <div className="card"><h1>Chat</h1><p className="muted small">Chat isn&apos;t switched on yet. It needs database update-0049.</p></div>
        ) : (
          <ChatApp
            me={{ id: access.user_id, name: access.display_name, photo_url: myPhoto ? urls.get(myPhoto) ?? null : null }}
            initialRooms={rooms.map(withUrl)}
            people={people.map(withUrl)}
            initialRoom={room?.[0] ?? null}
            management={can(access, ["OWNER"], null) || can(access, ["MANAGER"], null)}
          />
        )}
      </main>
    </>
  );
}
