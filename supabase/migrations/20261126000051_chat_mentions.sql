-- update-0051: @mentions in group chats (CHRIS, Nov 26, 2026).
--   * Type @ in a group chat to pick people (A to Z); several people per message.
--   * @all tags everyone in the group, for announcements (owners and the GM only).
--   * Tagged people get a sound, a highlighted message, an @ on the chat in their list, and a bell notification.

ALTER TABLE public.chat_messages ADD COLUMN IF NOT EXISTS mentions uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE public.chat_messages ADD COLUMN IF NOT EXISTS mention_all boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.chat_send(p_room uuid, p_body text, p_photo_path text, p_gif_url text, p_mentions uuid[], p_all boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id(); m public.chat_messages%ROWTYPE; v_body text := nullif(btrim(coalesce(p_body, '')), '');
  v_mentions uuid[]; v_all boolean := coalesce(p_all, false); r public.chat_rooms%ROWTYPE; v_title text;
BEGIN
  IF v_user IS NULL OR NOT private.is_chat_member(p_room) THEN RETURN jsonb_build_object('ok', false, 'error', 'FORBIDDEN'); END IF;
  IF v_body IS NULL AND p_photo_path IS NULL AND p_gif_url IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'EMPTY_MESSAGE'); END IF;
  IF char_length(coalesce(v_body, '')) > 4000 THEN RETURN jsonb_build_object('ok', false, 'error', 'MESSAGE_TOO_LONG'); END IF;
  -- A photo must be in this chat's folder, under the sender's own name.
  IF p_photo_path IS NOT NULL AND p_photo_path !~ ('^' || p_room::text || '/' || v_user::text || '/[A-Za-z0-9-]+\.(jpg|png|webp|gif)$') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
  END IF;
  IF p_gif_url IS NOT NULL AND p_gif_url !~ '^https://media[0-9]*\.giphy\.com/[A-Za-z0-9/._-]+$' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
  END IF;
  SELECT * INTO r FROM public.chat_rooms WHERE id = p_room;
  -- Tags only in group chats, only of people in the chat. @all is for announcements: owners and the GM only.
  IF r.kind <> 'GROUP' THEN v_all := false; END IF;
  IF v_all AND NOT private.is_management(v_user) THEN RETURN jsonb_build_object('ok', false, 'error', 'ALL_NOT_ALLOWED'); END IF;
  SELECT coalesce(array_agg(DISTINCT x), '{}') INTO v_mentions FROM unnest(coalesce(p_mentions, '{}')) x
  WHERE r.kind = 'GROUP' AND x <> v_user AND EXISTS (SELECT 1 FROM public.chat_members cm WHERE cm.room_id = p_room AND cm.user_id = x);
  INSERT INTO public.chat_messages (room_id, sender_id, body, photo_path, gif_url, from_management, mentions, mention_all)
  VALUES (p_room, v_user, v_body, p_photo_path, p_gif_url, private.is_management(v_user), v_mentions, v_all)
  RETURNING * INTO m;
  -- Tagged people (or everyone, for @all) also get it in their bell.
  IF v_all OR cardinality(v_mentions) > 0 THEN
    v_title := left(coalesce((SELECT display_name FROM public.app_users WHERE id = v_user), 'Someone')
               || CASE WHEN v_all THEN ' tagged everyone in ' ELSE ' tagged you in ' END || coalesce(r.name, 'a chat'), 200);
    INSERT INTO public.notifications (organization_id, user_id, kind, title, body, link, created_by)
    SELECT r.organization_id, cm.user_id, 'CHAT_MENTION', v_title, left(coalesce(v_body, 'Photo'), 1000), '/chat/' || p_room::text, v_user
    FROM public.chat_members cm WHERE cm.room_id = p_room AND cm.user_id <> v_user AND (v_all OR cm.user_id = ANY (v_mentions));
  END IF;
  UPDATE public.chat_rooms SET last_message_at = m.created_at WHERE id = p_room;
  UPDATE public.chat_members SET last_read_at = m.created_at WHERE room_id = p_room AND user_id = v_user;
  RETURN jsonb_build_object('ok', true, 'message', to_jsonb(m));
END $$;


-- The 4-value version (update-0049) keeps working for screens that don't tag anyone.
CREATE OR REPLACE FUNCTION public.chat_send(p_room uuid, p_body text, p_photo_path text, p_gif_url text) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$ SELECT public.chat_send(p_room, p_body, p_photo_path, p_gif_url, NULL::uuid[], false) $$;

REVOKE ALL ON FUNCTION public.chat_send(uuid, text, text, text, uuid[], boolean), public.chat_send(uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.chat_send(uuid, text, text, text, uuid[], boolean), public.chat_send(uuid, text, text, text) TO authenticated;

-- chat_list: as in update-0050, plus how many unread messages tag me (mention_unread).
CREATE OR REPLACE FUNCTION public.chat_list() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id();
BEGIN
  IF v_user IS NULL THEN RETURN '[]'::jsonb; END IF;
  PERFORM private.chat_sync_org(private.current_org_id());
  RETURN coalesce((
    SELECT jsonb_agg(x ORDER BY x.last_at DESC) FROM (
      SELECT r.id, r.kind, r.auto_key IS NOT NULL AS auto,
        CASE WHEN r.kind = 'DM' THEN o.display_name ELSE r.name END AS name,
        CASE WHEN r.kind = 'DM' THEN o.photo_path END AS photo_path,
        CASE WHEN r.kind = 'DM' THEN o.id END AS other_id,
        r.last_message_at AS last_at,
        (SELECT count(*) FROM public.chat_members c WHERE c.room_id = r.id) AS members,
        (SELECT count(*) FROM public.chat_messages msg WHERE msg.room_id = r.id AND msg.created_at > m.last_read_at
           AND msg.sender_id <> v_user AND msg.deleted_at IS NULL) AS unread,
        (SELECT count(*) FROM public.chat_messages msg WHERE msg.room_id = r.id AND msg.created_at > m.last_read_at
           AND msg.sender_id <> v_user AND msg.deleted_at IS NULL AND msg.from_management) AS mgmt_unread,
        (SELECT count(*) FROM public.chat_messages msg WHERE msg.room_id = r.id AND msg.created_at > m.last_read_at
           AND msg.sender_id <> v_user AND msg.deleted_at IS NULL AND (msg.mention_all OR v_user = ANY (msg.mentions))) AS mention_unread,
        (SELECT jsonb_build_object('sender', s.display_name, 'mine', l.sender_id = v_user, 'mgmt', l.from_management,
                  'text', CASE WHEN l.deleted_at IS NOT NULL THEN 'Message deleted'
                               WHEN l.body IS NOT NULL AND btrim(l.body) <> '' THEN left(l.body, 120)
                               WHEN l.gif_url IS NOT NULL THEN 'GIF' ELSE 'Photo' END)
           FROM public.chat_messages l JOIN public.app_users s ON s.id = l.sender_id
           WHERE l.room_id = r.id ORDER BY l.created_at DESC LIMIT 1) AS last
      FROM public.chat_members m
      JOIN public.chat_rooms r ON r.id = m.room_id
      LEFT JOIN LATERAL (SELECT u.id, u.display_name, u.photo_path FROM public.chat_members om JOIN public.app_users u ON u.id = om.user_id
                         WHERE r.kind = 'DM' AND om.room_id = r.id AND om.user_id <> v_user LIMIT 1) o ON true
      WHERE m.user_id = v_user
    ) x), '[]'::jsonb);
END $$;


-- View as (owners and the GM): how many chat messages the person hasn't read, and how many are from management.
-- Counts only, never the messages themselves: chats stay private (CHRIS, Nov 26).
CREATE OR REPLACE FUNCTION public.view_as_chat(p_user uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT private.can_view_as() OR NOT EXISTS (SELECT 1 FROM public.app_users WHERE id = p_user AND organization_id = private.current_org_id()) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'FORBIDDEN');
  END IF;
  RETURN (
    SELECT jsonb_build_object('ok', true, 'unread', count(*), 'mgmt_unread', count(*) FILTER (WHERE msg.from_management),
             'tagged_unread', count(*) FILTER (WHERE msg.mention_all OR p_user = ANY (msg.mentions)))
    FROM public.chat_members m JOIN public.chat_messages msg ON msg.room_id = m.room_id
    WHERE m.user_id = p_user AND msg.created_at > m.last_read_at AND msg.sender_id <> p_user AND msg.deleted_at IS NULL);
END $$;
REVOKE ALL ON FUNCTION public.view_as_chat(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.view_as_chat(uuid) TO authenticated;
