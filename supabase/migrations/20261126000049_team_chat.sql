-- update-0049: team chat inside Hermosa OS (CHRIS, Nov 26, 2026).
--   * 1-on-1 private messages, group chats, photos (GIF column ready for the next build), unread counts, "seen".
--   * Automatic groups: "All staff", and one per branch (its staff, plus owners and the GM).
--   * PRIVATE: only the people in a chat can read it. Owners and the GM get NO special access (CHRIS: "keep chats
--     private until I say so"). Messages are kept until the sender deletes them.
--   * Messages from management (owners and the GM) are flagged, and staff get a loud, can't-miss notice for them.
--   * Photos live in the private "chat" storage folder: <room>/<sender>/<file>.jpg, readable only by the chat's members.

CREATE TABLE IF NOT EXISTS public.chat_rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  kind text NOT NULL CHECK (kind IN ('DM','GROUP')),
  name text CHECK (name IS NULL OR char_length(btrim(name)) BETWEEN 1 AND 60),
  auto_key text,            -- 'ALL' or 'BRANCH:<branch id>' for the automatic groups
  dm_key text,              -- '<smaller user id>:<larger user id>' for 1-on-1 chats
  created_by uuid REFERENCES public.app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS chat_rooms_auto ON public.chat_rooms (organization_id, auto_key) WHERE auto_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS chat_rooms_dm ON public.chat_rooms (organization_id, dm_key) WHERE dm_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.chat_members (
  room_id uuid NOT NULL REFERENCES public.chat_rooms(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.app_users(id),
  joined_at timestamptz NOT NULL DEFAULT now(),
  last_read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);
CREATE INDEX IF NOT EXISTS chat_members_user ON public.chat_members (user_id);

CREATE TABLE IF NOT EXISTS public.chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES public.chat_rooms(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES public.app_users(id),
  body text CHECK (body IS NULL OR char_length(body) <= 4000),
  photo_path text,
  gif_url text CHECK (gif_url IS NULL OR gif_url ~ '^https://media[0-9]*\.giphy\.com/[A-Za-z0-9/._-]+$'),
  from_management boolean NOT NULL DEFAULT false,  -- sent by an owner or the GM (company-wide OWNER/MANAGER)
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS chat_messages_room ON public.chat_messages (room_id, created_at DESC);

-- Is the signed-in person in this chat? (SECURITY DEFINER so the policies don't loop on chat_members.)
CREATE OR REPLACE FUNCTION private.is_chat_member(p_room uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.chat_members m WHERE m.room_id = p_room AND m.user_id = private.current_user_id())
$$;
REVOKE ALL ON FUNCTION private.is_chat_member(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.is_chat_member(uuid) TO authenticated;

-- Management = owners and the GM (CHRIS's wording, Nov 25): a company-wide OWNER or MANAGER grant.
CREATE OR REPLACE FUNCTION private.is_management(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.role_grants g WHERE g.user_id = p_user AND g.revoked_at IS NULL
                 AND g.branch_id IS NULL AND g.role_code IN ('OWNER','MANAGER'))
$$;
REVOKE ALL ON FUNCTION private.is_management(uuid) FROM PUBLIC, anon, authenticated;

ALTER TABLE public.chat_rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS chat_rooms_read ON public.chat_rooms;
CREATE POLICY chat_rooms_read ON public.chat_rooms FOR SELECT TO authenticated USING (private.is_chat_member(id));
DROP POLICY IF EXISTS chat_members_read ON public.chat_members;
CREATE POLICY chat_members_read ON public.chat_members FOR SELECT TO authenticated USING (private.is_chat_member(room_id));
DROP POLICY IF EXISTS chat_messages_read ON public.chat_messages;
CREATE POLICY chat_messages_read ON public.chat_messages FOR SELECT TO authenticated USING (private.is_chat_member(room_id));
REVOKE ALL ON public.chat_rooms, public.chat_members, public.chat_messages FROM anon, authenticated;
GRANT SELECT ON public.chat_rooms, public.chat_members, public.chat_messages TO authenticated;

-- Automatic groups for one person: "All staff" for everyone; their branch's group; owners and the GM join every branch group.
CREATE OR REPLACE FUNCTION private.chat_sync(p_user uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_org uuid; v_room uuid; v_all_branches boolean; b record;
BEGIN
  SELECT organization_id INTO v_org FROM public.app_users WHERE id = p_user AND active AND join_status = 'APPROVED';
  IF v_org IS NULL THEN RETURN; END IF;
  INSERT INTO public.chat_rooms (organization_id, kind, name, auto_key) VALUES (v_org, 'GROUP', 'All staff', 'ALL')
  ON CONFLICT (organization_id, auto_key) WHERE auto_key IS NOT NULL DO NOTHING;
  SELECT id INTO v_room FROM public.chat_rooms WHERE organization_id = v_org AND auto_key = 'ALL';
  INSERT INTO public.chat_members (room_id, user_id) VALUES (v_room, p_user) ON CONFLICT DO NOTHING;

  v_all_branches := EXISTS (SELECT 1 FROM public.role_grants g WHERE g.user_id = p_user AND g.revoked_at IS NULL
                            AND g.branch_id IS NULL AND g.role_code IN ('OWNER','MANAGER'));
  FOR b IN
    SELECT br.id, br.name,
           (v_all_branches OR EXISTS (SELECT 1 FROM public.employees e WHERE e.app_user_id = p_user AND e.active AND e.branch_id = br.id)) AS mine
    FROM public.branches br WHERE br.organization_id = v_org AND br.active AND br.kind IN ('CLINIC','WFH')
  LOOP
    IF b.mine THEN
      INSERT INTO public.chat_rooms (organization_id, kind, name, auto_key) VALUES (v_org, 'GROUP', left(b.name || ' team', 60), 'BRANCH:' || b.id)
      ON CONFLICT (organization_id, auto_key) WHERE auto_key IS NOT NULL DO NOTHING;
      SELECT id INTO v_room FROM public.chat_rooms WHERE organization_id = v_org AND auto_key = 'BRANCH:' || b.id;
      INSERT INTO public.chat_members (room_id, user_id) VALUES (v_room, p_user) ON CONFLICT DO NOTHING;
    ELSE
      -- Moved branch: leave the old branch's group.
      DELETE FROM public.chat_members m USING public.chat_rooms r
      WHERE m.room_id = r.id AND r.organization_id = v_org AND r.auto_key = 'BRANCH:' || b.id AND m.user_id = p_user;
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION private.chat_sync(uuid) FROM PUBLIC, anon, authenticated;

-- My chats, newest first, with the last message and how many I haven't read.
CREATE OR REPLACE FUNCTION public.chat_list() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id();
BEGIN
  IF v_user IS NULL THEN RETURN '[]'::jsonb; END IF;
  PERFORM private.chat_sync(v_user);
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

-- Everyone I can start a chat with (active, approved accounts in my organization).
CREATE OR REPLACE FUNCTION public.chat_people() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'name', u.display_name, 'photo_path', u.photo_path) ORDER BY u.display_name), '[]'::jsonb)
  FROM public.app_users u
  WHERE u.organization_id = private.current_org_id() AND u.active AND u.join_status = 'APPROVED' AND u.id <> private.current_user_id()
$$;

-- One chat's details: its members (with when they last read) for names, pictures and "seen".
CREATE OR REPLACE FUNCTION public.chat_room(p_room uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id(); r public.chat_rooms%ROWTYPE;
BEGIN
  IF v_user IS NULL OR NOT private.is_chat_member(p_room) THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  SELECT * INTO r FROM public.chat_rooms WHERE id = p_room;
  RETURN jsonb_build_object('ok', true, 'id', r.id, 'kind', r.kind, 'auto', r.auto_key IS NOT NULL,
    'name', CASE WHEN r.kind = 'DM' THEN (SELECT u.display_name FROM public.chat_members m JOIN public.app_users u ON u.id = m.user_id
                                          WHERE m.room_id = r.id AND m.user_id <> v_user LIMIT 1) ELSE r.name END,
    'members', (SELECT jsonb_agg(jsonb_build_object('id', u.id, 'name', u.display_name, 'photo_path', u.photo_path, 'last_read_at', m.last_read_at)
                                 ORDER BY u.display_name)
                FROM public.chat_members m JOIN public.app_users u ON u.id = m.user_id WHERE m.room_id = r.id));
END $$;

CREATE OR REPLACE FUNCTION public.chat_start_dm(p_user uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id(); v_org uuid := private.current_org_id(); v_key text; v_room uuid;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF p_user IS NULL OR p_user = v_user OR NOT EXISTS (SELECT 1 FROM public.app_users WHERE id = p_user AND organization_id = v_org AND active AND join_status = 'APPROVED') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
  END IF;
  v_key := least(v_user::text, p_user::text) || ':' || greatest(v_user::text, p_user::text);
  INSERT INTO public.chat_rooms (organization_id, kind, dm_key, created_by) VALUES (v_org, 'DM', v_key, v_user)
  ON CONFLICT (organization_id, dm_key) WHERE dm_key IS NOT NULL DO NOTHING;
  SELECT id INTO v_room FROM public.chat_rooms WHERE organization_id = v_org AND dm_key = v_key;
  INSERT INTO public.chat_members (room_id, user_id) VALUES (v_room, v_user), (v_room, p_user) ON CONFLICT DO NOTHING;
  RETURN jsonb_build_object('ok', true, 'id', v_room);
END $$;

CREATE OR REPLACE FUNCTION public.chat_create_group(p_name text, p_members uuid[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id(); v_org uuid := private.current_org_id(); v_room uuid;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF p_name IS NULL OR char_length(btrim(p_name)) NOT BETWEEN 1 AND 60 THEN RETURN jsonb_build_object('ok', false, 'error', 'NAME_REQUIRED'); END IF;
  INSERT INTO public.chat_rooms (organization_id, kind, name, created_by) VALUES (v_org, 'GROUP', btrim(p_name), v_user) RETURNING id INTO v_room;
  INSERT INTO public.chat_members (room_id, user_id)
  SELECT v_room, u.id FROM public.app_users u
  WHERE u.organization_id = v_org AND u.active AND u.join_status = 'APPROVED' AND (u.id = v_user OR u.id = ANY (coalesce(p_members, '{}')))
  ON CONFLICT DO NOTHING;
  RETURN jsonb_build_object('ok', true, 'id', v_room);
END $$;

-- Groups you made or joined: add people, rename, leave. The automatic groups manage themselves.
CREATE OR REPLACE FUNCTION public.chat_add_members(p_room uuid, p_members uuid[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_org uuid := private.current_org_id();
BEGIN
  IF NOT private.is_chat_member(p_room) OR NOT EXISTS (SELECT 1 FROM public.chat_rooms WHERE id = p_room AND kind = 'GROUP' AND auto_key IS NULL) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'FORBIDDEN');
  END IF;
  INSERT INTO public.chat_members (room_id, user_id)
  SELECT p_room, u.id FROM public.app_users u WHERE u.organization_id = v_org AND u.active AND u.join_status = 'APPROVED' AND u.id = ANY (coalesce(p_members, '{}'))
  ON CONFLICT DO NOTHING;
  RETURN jsonb_build_object('ok', true);
END $$;

CREATE OR REPLACE FUNCTION public.chat_rename(p_room uuid, p_name text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT private.is_chat_member(p_room) OR NOT EXISTS (SELECT 1 FROM public.chat_rooms WHERE id = p_room AND kind = 'GROUP' AND auto_key IS NULL) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'FORBIDDEN');
  END IF;
  IF p_name IS NULL OR char_length(btrim(p_name)) NOT BETWEEN 1 AND 60 THEN RETURN jsonb_build_object('ok', false, 'error', 'NAME_REQUIRED'); END IF;
  UPDATE public.chat_rooms SET name = btrim(p_name) WHERE id = p_room;
  RETURN jsonb_build_object('ok', true);
END $$;

CREATE OR REPLACE FUNCTION public.chat_leave(p_room uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT private.is_chat_member(p_room) OR NOT EXISTS (SELECT 1 FROM public.chat_rooms WHERE id = p_room AND kind = 'GROUP' AND auto_key IS NULL) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'FORBIDDEN');
  END IF;
  DELETE FROM public.chat_members WHERE room_id = p_room AND user_id = private.current_user_id();
  RETURN jsonb_build_object('ok', true);
END $$;

CREATE OR REPLACE FUNCTION public.chat_send(p_room uuid, p_body text, p_photo_path text, p_gif_url text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id(); m public.chat_messages%ROWTYPE; v_body text := nullif(btrim(coalesce(p_body, '')), '');
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
  INSERT INTO public.chat_messages (room_id, sender_id, body, photo_path, gif_url, from_management)
  VALUES (p_room, v_user, v_body, p_photo_path, p_gif_url, private.is_management(v_user))
  RETURNING * INTO m;
  UPDATE public.chat_rooms SET last_message_at = m.created_at WHERE id = p_room;
  UPDATE public.chat_members SET last_read_at = m.created_at WHERE room_id = p_room AND user_id = v_user;
  RETURN jsonb_build_object('ok', true, 'message', to_jsonb(m));
END $$;

-- Delete your own message: the text and photo are wiped; a "Message deleted" line stays in its place.
CREATE OR REPLACE FUNCTION public.chat_delete_message(p_message uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id(); v_photo text;
BEGIN
  SELECT photo_path INTO v_photo FROM public.chat_messages WHERE id = p_message AND sender_id = v_user AND deleted_at IS NULL;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  UPDATE public.chat_messages SET body = NULL, photo_path = NULL, gif_url = NULL, deleted_at = now() WHERE id = p_message;
  RETURN jsonb_build_object('ok', true, 'photo_path', v_photo);
END $$;

CREATE OR REPLACE FUNCTION public.chat_mark_read(p_room uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.chat_members SET last_read_at = now() WHERE room_id = p_room AND user_id = private.current_user_id();
  RETURN jsonb_build_object('ok', FOUND);
END $$;

-- Unread messages across all my chats (the red badge on the Chat menu item).
CREATE OR REPLACE FUNCTION public.chat_unread() RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT count(*)::integer FROM public.chat_members m JOIN public.chat_messages msg ON msg.room_id = m.room_id
  WHERE m.user_id = private.current_user_id() AND msg.created_at > m.last_read_at AND msg.sender_id <> m.user_id AND msg.deleted_at IS NULL
$$;

-- Unread messages from management, newest first (the can't-miss notice staff see on every page until they open them).
-- Owners and the GM don't get this notice for each other's messages.
CREATE OR REPLACE FUNCTION public.chat_mgmt_unread() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(jsonb_agg(x ORDER BY x.created_at DESC), '[]'::jsonb) FROM (
    SELECT msg.id, msg.room_id, msg.created_at, s.display_name AS sender,
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
REVOKE ALL ON FUNCTION public.chat_list(), public.chat_people(), public.chat_room(uuid), public.chat_start_dm(uuid),
  public.chat_create_group(text, uuid[]), public.chat_add_members(uuid, uuid[]), public.chat_rename(uuid, text), public.chat_leave(uuid),
  public.chat_send(uuid, text, text, text), public.chat_delete_message(uuid), public.chat_mark_read(uuid), public.chat_unread() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.chat_list(), public.chat_people(), public.chat_room(uuid), public.chat_start_dm(uuid),
  public.chat_create_group(text, uuid[]), public.chat_add_members(uuid, uuid[]), public.chat_rename(uuid, text), public.chat_leave(uuid),
  public.chat_send(uuid, text, text, text), public.chat_delete_message(uuid), public.chat_mark_read(uuid), public.chat_unread() TO authenticated;

-- Live updates (Supabase Realtime): new messages and "seen" arrive without refreshing. Realtime applies the read rules above.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'chat_messages') THEN
      EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_messages';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'chat_members') THEN
      EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_members';
    END IF;
  END IF;
END $$;

-- Private photo folder: <room>/<sender>/<file>. Members of the chat can see; you upload and delete only under your own name.
DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES ('chat', 'chat', false, 5242880, ARRAY['image/jpeg','image/png','image/webp','image/gif'])
    ON CONFLICT (id) DO NOTHING;
    EXECUTE 'DROP POLICY IF EXISTS chat_photos_insert ON storage.objects';
    EXECUTE $p$CREATE POLICY chat_photos_insert ON storage.objects FOR INSERT TO authenticated
      WITH CHECK (bucket_id = 'chat' AND (storage.foldername(name))[2] = private.current_user_id()::text
                  AND private.is_chat_member(((storage.foldername(name))[1])::uuid))$p$;
    EXECUTE 'DROP POLICY IF EXISTS chat_photos_read ON storage.objects';
    EXECUTE $p$CREATE POLICY chat_photos_read ON storage.objects FOR SELECT TO authenticated
      USING (bucket_id = 'chat' AND private.is_chat_member(((storage.foldername(name))[1])::uuid))$p$;
    EXECUTE 'DROP POLICY IF EXISTS chat_photos_delete ON storage.objects';
    EXECUTE $p$CREATE POLICY chat_photos_delete ON storage.objects FOR DELETE TO authenticated
      USING (bucket_id = 'chat' AND (storage.foldername(name))[2] = private.current_user_id()::text)$p$;
  END IF;
END $$;
