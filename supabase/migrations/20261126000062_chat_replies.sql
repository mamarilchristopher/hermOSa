-- update-0062 (CHRIS Nov 26): chat replies and management labels.
--   * Reply to a chosen chat message. (Double-tap to heart uses the existing reactions.)
--   * Management messages are labelled "Message from <first name>".
--   * Group photos: every group starts with the Hermosa logo; only owners and the GM change it.
ALTER TABLE public.chat_messages ADD COLUMN IF NOT EXISTS reply_to uuid REFERENCES public.chat_messages(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION public.chat_send(p_room uuid, p_body text, p_photo_path text, p_gif_url text, p_mentions uuid[], p_all boolean, p_reply_to uuid) RETURNS jsonb
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
  -- update-0062: a reply quotes a message from the same chat.
  IF p_reply_to IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.chat_messages q WHERE q.id = p_reply_to AND q.room_id = p_room) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
  END IF;
  SELECT * INTO r FROM public.chat_rooms WHERE id = p_room;
  -- Tags only in group chats, only of people in the chat. @all is for announcements: owners and the GM only.
  IF r.kind <> 'GROUP' THEN v_all := false; END IF;
  IF v_all AND NOT private.is_management(v_user) THEN RETURN jsonb_build_object('ok', false, 'error', 'ALL_NOT_ALLOWED'); END IF;
  SELECT coalesce(array_agg(DISTINCT x), '{}') INTO v_mentions FROM unnest(coalesce(p_mentions, '{}')) x
  WHERE r.kind = 'GROUP' AND x <> v_user AND EXISTS (SELECT 1 FROM public.chat_members cm WHERE cm.room_id = p_room AND cm.user_id = x);
  INSERT INTO public.chat_messages (room_id, sender_id, body, photo_path, gif_url, from_management, mentions, mention_all, reply_to)
  VALUES (p_room, v_user, v_body, p_photo_path, p_gif_url, private.is_management(v_user), v_mentions, v_all, p_reply_to)
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

-- The older versions keep working, without a reply.
CREATE OR REPLACE FUNCTION public.chat_send(p_room uuid, p_body text, p_photo_path text, p_gif_url text, p_mentions uuid[], p_all boolean) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$ SELECT public.chat_send(p_room, p_body, p_photo_path, p_gif_url, p_mentions, p_all, NULL::uuid) $$;

REVOKE ALL ON FUNCTION public.chat_send(uuid, text, text, text, uuid[], boolean, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.chat_send(uuid, text, text, text, uuid[], boolean, uuid) TO authenticated;


-- update-0062: a person's short name: the approved nickname, else the first name (skipping "Ma."), else the account name.
CREATE OR REPLACE FUNCTION private.first_name(p_user uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(nullif(btrim(e.nickname), ''),
                  nullif(btrim((SELECT d.data ->> 'nickname' FROM public.employee_details d WHERE d.employee_id = e.id)), ''),
                  nullif(regexp_replace(btrim(e.full_name), '^(?:[Mm][Aa]\.?\s+)?(\S+).*$', '\1'), ''),
                  nullif(regexp_replace(btrim(u.display_name), '^(?:[Mm][Aa]\.?\s+)?(\S+).*$', '\1'), ''),
                  u.display_name)
  FROM public.app_users u
  LEFT JOIN LATERAL (SELECT e.id, e.full_name, e.nickname FROM public.employees e WHERE e.app_user_id = u.id ORDER BY e.active DESC LIMIT 1) e ON true
  WHERE u.id = p_user
$$;
REVOKE ALL ON FUNCTION private.first_name(uuid) FROM PUBLIC, anon, authenticated;

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
        r.icon_path,
        -- Groups without an icon show a combo of up to 3 members' faces (others first, people with a photo first).
        CASE WHEN r.kind = 'GROUP' AND r.auto_key IS NULL THEN (
          SELECT coalesce(jsonb_agg(f.user_id), '[]'::jsonb) FROM (
            SELECT fm.user_id FROM public.chat_members fm JOIN public.app_users fu ON fu.id = fm.user_id
            WHERE fm.room_id = r.id ORDER BY (fm.user_id = v_user), (fu.photo_path IS NULL), fm.user_id LIMIT 3) f) END AS face_ids,
        r.last_message_at AS last_at,
        (SELECT count(*) FROM public.chat_members c WHERE c.room_id = r.id) AS members,
        (SELECT count(*) FROM public.chat_messages msg WHERE msg.room_id = r.id AND msg.created_at > m.last_read_at
           AND msg.sender_id <> v_user AND msg.deleted_at IS NULL) AS unread,
        (SELECT count(*) FROM public.chat_messages msg WHERE msg.room_id = r.id AND msg.created_at > m.last_read_at
           AND msg.sender_id <> v_user AND msg.deleted_at IS NULL AND msg.from_management) AS mgmt_unread,
        -- update-0062: who the newest unread management message is from ("Message from <first name>").
        (SELECT private.first_name(msg.sender_id) FROM public.chat_messages msg WHERE msg.room_id = r.id AND msg.created_at > m.last_read_at
           AND msg.sender_id <> v_user AND msg.deleted_at IS NULL AND msg.from_management ORDER BY msg.created_at DESC LIMIT 1) AS mgmt_from,
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

-- update-0062: only owners and the GM change group photos (every group starts with the Hermosa logo).
CREATE OR REPLACE FUNCTION public.chat_set_icon(p_room uuid, p_path text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.chat_rooms; v_user uuid := private.current_user_id(); v_old text;
BEGIN
  SELECT * INTO r FROM public.chat_rooms WHERE id = p_room;
  IF NOT FOUND OR r.kind <> 'GROUP' OR NOT private.is_chat_member(p_room) OR NOT private.is_management(v_user) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'FORBIDDEN');
  END IF;
  IF p_path IS NOT NULL AND (p_path NOT LIKE p_room::text || '/' || v_user::text || '/%' OR p_path LIKE '%..%' OR char_length(p_path) > 200) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
  END IF;
  v_old := r.icon_path;
  UPDATE public.chat_rooms SET icon_path = p_path WHERE id = p_room;
  RETURN jsonb_build_object('ok', true, 'old', v_old);
END $$;
REVOKE ALL ON FUNCTION public.chat_set_icon(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.chat_set_icon(uuid, text) TO authenticated;

-- update-0062: the management notice names the sender by first name.
CREATE OR REPLACE FUNCTION public.chat_mgmt_unread() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(jsonb_agg(x ORDER BY x.created_at DESC), '[]'::jsonb) FROM (
    SELECT msg.id, msg.room_id, msg.created_at, s.display_name AS sender, private.first_name(msg.sender_id) AS sender_first,
           CASE WHEN r.kind = 'DM' THEN NULL ELSE r.name END AS room_name,
           CASE WHEN msg.body IS NOT NULL THEN left(msg.body, 300) WHEN msg.gif_url IS NOT NULL THEN 'GIF' ELSE 'Photo' END AS text
    FROM public.chat_members m
    JOIN public.chat_messages msg ON msg.room_id = m.room_id
    JOIN public.chat_rooms r ON r.id = m.room_id
    JOIN public.app_users s ON s.id = msg.sender_id
    WHERE m.user_id = private.current_user_id() AND NOT private.is_management(m.user_id)
      AND msg.from_management AND msg.created_at > m.last_read_at AND msg.sender_id <> m.user_id AND msg.deleted_at IS NULL
    ORDER BY msg.created_at DESC LIMIT 20) x
$$;
REVOKE ALL ON FUNCTION public.chat_mgmt_unread() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.chat_mgmt_unread() TO authenticated;
