-- update-0058: group chat icon photos (CHRIS Nov 26). 1-on-1 chats keep the other person's profile photo;
-- groups without an icon show a combo of members' profile photos.
ALTER TABLE public.chat_rooms ADD COLUMN IF NOT EXISTS icon_path text;

-- Set or clear a group's icon. The file is uploaded first to the private chat folder: <room>/<your id>/<file>.
-- Who: any member of a group someone made; for the automatic groups (All staff, branch teams), owners and the GM.
CREATE OR REPLACE FUNCTION public.chat_set_icon(p_room uuid, p_path text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.chat_rooms; v_user uuid := private.current_user_id(); v_old text;
BEGIN
  SELECT * INTO r FROM public.chat_rooms WHERE id = p_room;
  IF NOT FOUND OR r.kind <> 'GROUP' OR NOT private.is_chat_member(p_room)
     OR (r.auto_key IS NOT NULL AND NOT private.is_management(v_user)) THEN
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
