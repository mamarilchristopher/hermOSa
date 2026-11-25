-- update-0052: reactions, deleted messages for management, View as notifications (CHRIS, Nov 26, 2026).
--   * Anyone can react to a message with an emoji (tap again to take it back).
--   * Staff delete their own messages as before. Everyone else sees "Message deleted", but owners and the GM who are in
--     that chat still see what it said, crossed out. Chats stay private: management sees this only in chats they're in.
--   * A message deleted by an owner or the GM is gone for everyone, management included.
--   * View as shows the person's latest notifications (chat ones without the message text).

ALTER TABLE public.chat_messages ADD COLUMN IF NOT EXISTS deleted_by uuid REFERENCES public.app_users(id);

-- What a deleted message said. Only owners and the GM in that chat can read it, through chat_deleted_list.
CREATE TABLE IF NOT EXISTS public.chat_deleted (
  message_id uuid PRIMARY KEY REFERENCES public.chat_messages(id) ON DELETE CASCADE,
  room_id uuid NOT NULL REFERENCES public.chat_rooms(id) ON DELETE CASCADE,
  body text, photo_path text, gif_url text,
  deleted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_deleted_room ON public.chat_deleted (room_id);
ALTER TABLE public.chat_deleted ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.chat_deleted FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.chat_delete_message(p_message uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id(); m public.chat_messages%ROWTYPE;
BEGIN
  SELECT * INTO m FROM public.chat_messages WHERE id = p_message AND sender_id = v_user AND deleted_at IS NULL;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  -- Tag notices for this message lose the text too.
  DELETE FROM public.notifications WHERE kind = 'CHAT_MENTION' AND created_by = v_user AND link = '/chat/' || m.room_id::text AND created_at = m.created_at;
  IF private.is_management(v_user) THEN
    DELETE FROM public.chat_messages WHERE id = p_message;  -- gone for everyone (reactions go with it)
    RETURN jsonb_build_object('ok', true, 'gone', true, 'photo_path', m.photo_path);
  END IF;
  INSERT INTO public.chat_deleted (message_id, room_id, body, photo_path, gif_url) VALUES (m.id, m.room_id, m.body, m.photo_path, m.gif_url)
  ON CONFLICT (message_id) DO NOTHING;
  UPDATE public.chat_messages SET body = NULL, photo_path = NULL, gif_url = NULL, mentions = '{}', mention_all = false,
    deleted_at = now(), deleted_by = v_user WHERE id = p_message;
  RETURN jsonb_build_object('ok', true, 'gone', false, 'photo_path', NULL);  -- the photo is kept for management
END $$;

-- For owners and the GM in this chat: what the deleted messages said.
CREATE OR REPLACE FUNCTION public.chat_deleted_list(p_room uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('message_id', d.message_id, 'body', d.body, 'photo_path', d.photo_path, 'gif_url', d.gif_url)), '[]'::jsonb)
  FROM public.chat_deleted d
  WHERE d.room_id = p_room AND private.is_chat_member(p_room) AND private.is_management(private.current_user_id())
$$;
REVOKE ALL ON FUNCTION public.chat_deleted_list(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.chat_deleted_list(uuid) TO authenticated;

-- Management may still open photos from deleted messages in their chats (the folder rules already allow chat members).

-- Reactions.
CREATE TABLE IF NOT EXISTS public.chat_reactions (
  message_id uuid NOT NULL REFERENCES public.chat_messages(id) ON DELETE CASCADE,
  room_id uuid NOT NULL REFERENCES public.chat_rooms(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.app_users(id),
  emoji text NOT NULL CHECK (octet_length(emoji) BETWEEN 1 AND 32 AND emoji !~ '[A-Za-z0-9<>&"''\s]'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS chat_reactions_room ON public.chat_reactions (room_id);
ALTER TABLE public.chat_reactions ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.chat_reactions TO authenticated;
DROP POLICY IF EXISTS chat_reactions_read ON public.chat_reactions;
CREATE POLICY chat_reactions_read ON public.chat_reactions FOR SELECT TO authenticated USING (private.is_chat_member(room_id));

-- React, or take the reaction back if it's already there. At most 6 different reactions per person per message.
CREATE OR REPLACE FUNCTION public.chat_react(p_message uuid, p_emoji text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id(); m public.chat_messages%ROWTYPE; v_e text := btrim(coalesce(p_emoji, ''));
BEGIN
  SELECT * INTO m FROM public.chat_messages WHERE id = p_message AND deleted_at IS NULL;
  IF v_user IS NULL OR NOT FOUND OR NOT private.is_chat_member(m.room_id) THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF octet_length(v_e) NOT BETWEEN 1 AND 32 OR v_e ~ '[A-Za-z0-9<>&"''\s]' THEN RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST'); END IF;
  DELETE FROM public.chat_reactions WHERE message_id = p_message AND user_id = v_user AND emoji = v_e;
  IF FOUND THEN RETURN jsonb_build_object('ok', true, 'on', false); END IF;
  IF (SELECT count(*) FROM public.chat_reactions WHERE message_id = p_message AND user_id = v_user) >= 6 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'TOO_MANY');
  END IF;
  INSERT INTO public.chat_reactions (message_id, room_id, user_id, emoji) VALUES (p_message, m.room_id, v_user, v_e);
  RETURN jsonb_build_object('ok', true, 'on', true);
END $$;
REVOKE ALL ON FUNCTION public.chat_react(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.chat_react(uuid, text) TO authenticated;

-- Live updates for reactions, and removed messages.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'chat_reactions') THEN
      EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_reactions';
    END IF;
  END IF;
END $$;

-- View as: the person's latest notifications. Chat ones show only that they were tagged, never the message.
CREATE OR REPLACE FUNCTION public.view_as_notices(p_user uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT private.can_view_as() OR NOT EXISTS (SELECT 1 FROM public.app_users WHERE id = p_user AND organization_id = private.current_org_id()) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'FORBIDDEN');
  END IF;
  RETURN jsonb_build_object('ok', true,
    'unread', (SELECT count(*) FROM public.notifications WHERE user_id = p_user AND read_at IS NULL),
    'latest', coalesce((SELECT jsonb_agg(x ORDER BY x.created_at DESC) FROM (
      SELECT CASE WHEN n.kind LIKE 'CHAT%' THEN 'Tagged in a chat' ELSE n.title END AS title,
             CASE WHEN n.kind LIKE 'CHAT%' THEN NULL ELSE left(n.body, 200) END AS body,
             n.kind, n.created_at, n.read_at IS NOT NULL AS read
      FROM public.notifications n WHERE n.user_id = p_user ORDER BY n.created_at DESC LIMIT 15) x), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION public.view_as_notices(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.view_as_notices(uuid) TO authenticated;
