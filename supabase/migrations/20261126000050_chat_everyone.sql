-- update-0050: everyone is in their chats from the start (CHRIS, Nov 26, 2026).
--   * All staff and each branch team now include every approved account right away, not only once each person opens Chat,
--     so a message left there waits for people who are offline or haven't opened Chat yet.
--   * Owners and the GM can add anyone to any group, the automatic ones included. People added by hand stay even if
--     they're from another branch (the automatic sync only adds and removes people it added itself).

ALTER TABLE public.chat_members ADD COLUMN IF NOT EXISTS auto boolean NOT NULL DEFAULT false;
-- Members of the automatic groups so far were all added by the sync.
UPDATE public.chat_members m SET auto = true FROM public.chat_rooms r WHERE r.id = m.room_id AND r.auto_key IS NOT NULL AND NOT m.auto;

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
  INSERT INTO public.chat_members (room_id, user_id, auto) VALUES (v_room, p_user, true) ON CONFLICT DO NOTHING;

  v_all_branches := private.is_management(p_user);
  FOR b IN
    SELECT br.id, br.name,
           (v_all_branches OR EXISTS (SELECT 1 FROM public.employees e WHERE e.app_user_id = p_user AND e.active AND e.branch_id = br.id)) AS mine
    FROM public.branches br WHERE br.organization_id = v_org AND br.active AND br.kind IN ('CLINIC','WFH')
  LOOP
    IF b.mine THEN
      INSERT INTO public.chat_rooms (organization_id, kind, name, auto_key) VALUES (v_org, 'GROUP', left(b.name || ' team', 60), 'BRANCH:' || b.id)
      ON CONFLICT (organization_id, auto_key) WHERE auto_key IS NOT NULL DO NOTHING;
      SELECT id INTO v_room FROM public.chat_rooms WHERE organization_id = v_org AND auto_key = 'BRANCH:' || b.id;
      INSERT INTO public.chat_members (room_id, user_id, auto) VALUES (v_room, p_user, true) ON CONFLICT DO NOTHING;
    ELSE
      -- Moved branch: leave the old branch's group, unless someone added them there by hand.
      DELETE FROM public.chat_members m USING public.chat_rooms r
      WHERE m.room_id = r.id AND r.organization_id = v_org AND r.auto_key = 'BRANCH:' || b.id AND m.user_id = p_user AND m.auto;
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION private.chat_sync(uuid) FROM PUBLIC, anon, authenticated;

-- Everyone in the organization at once (a handful of people, so this is quick).
CREATE OR REPLACE FUNCTION private.chat_sync_org(p_org uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE u uuid;
BEGIN
  FOR u IN SELECT id FROM public.app_users WHERE organization_id = p_org AND active AND join_status = 'APPROVED' LOOP
    PERFORM private.chat_sync(u);
  END LOOP;
  -- Switched-off accounts leave the automatic groups.
  DELETE FROM public.chat_members m USING public.chat_rooms r, public.app_users a
  WHERE m.room_id = r.id AND r.organization_id = p_org AND r.auto_key IS NOT NULL AND m.auto AND a.id = m.user_id
    AND (NOT a.active OR a.join_status <> 'APPROVED');
END $$;
REVOKE ALL ON FUNCTION private.chat_sync_org(uuid) FROM PUBLIC, anon, authenticated;

-- chat_list: same as update-0049, but brings the whole organization's automatic groups up to date first.
DO $$
DECLARE v_def text;
BEGIN
  v_def := pg_get_functiondef('public.chat_list()'::regprocedure);
  IF v_def NOT LIKE '%chat_sync_org%' THEN
    IF v_def NOT LIKE '%PERFORM private.chat_sync(v_user);%' THEN RAISE EXCEPTION 'update-0049 must be run first'; END IF;
    v_def := replace(v_def, 'PERFORM private.chat_sync(v_user);', 'PERFORM private.chat_sync_org(private.current_org_id());');
    EXECUTE v_def;
  END IF;
END $$;

-- Add people: anyone in a group they made; owners and the GM in any group, the automatic ones included.
CREATE OR REPLACE FUNCTION public.chat_add_members(p_room uuid, p_members uuid[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_org uuid := private.current_org_id(); v_user uuid := private.current_user_id();
BEGIN
  IF NOT private.is_chat_member(p_room) OR NOT EXISTS (
       SELECT 1 FROM public.chat_rooms WHERE id = p_room AND kind = 'GROUP' AND (auto_key IS NULL OR private.is_management(v_user))) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'FORBIDDEN');
  END IF;
  INSERT INTO public.chat_members (room_id, user_id, auto)
  SELECT p_room, u.id, false FROM public.app_users u WHERE u.organization_id = v_org AND u.active AND u.join_status = 'APPROVED' AND u.id = ANY (coalesce(p_members, '{}'))
  ON CONFLICT (room_id, user_id) DO UPDATE SET auto = false;
  RETURN jsonb_build_object('ok', true);
END $$;

-- Who may add people here (for the app's Add people button).
CREATE OR REPLACE FUNCTION public.chat_can_add(p_room uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT private.is_chat_member(p_room) AND EXISTS (
    SELECT 1 FROM public.chat_rooms WHERE id = p_room AND kind = 'GROUP' AND (auto_key IS NULL OR private.is_management(private.current_user_id())))
$$;
REVOKE ALL ON FUNCTION public.chat_can_add(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.chat_can_add(uuid) TO authenticated;

-- Bring everyone in now.
DO $$
DECLARE o uuid;
BEGIN
  FOR o IN SELECT id FROM public.organizations LOOP PERFORM private.chat_sync_org(o); END LOOP;
END $$;

-- Delete a conversation (CHRIS, Nov 26): it's gone for everyone in it, with its messages and photos.
--   * 1-on-1: either person.   * A group: whoever made it, or an owner / the GM.
--   * All staff and branch teams can't be removed; an owner or the GM can clear their messages instead.
CREATE OR REPLACE FUNCTION private.chat_can_delete(p_room uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT private.is_chat_member(p_room) AND EXISTS (
    SELECT 1 FROM public.chat_rooms r WHERE r.id = p_room
      AND (r.kind = 'DM' OR (r.auto_key IS NULL AND r.created_by = private.current_user_id()) OR private.is_management(private.current_user_id())))
$$;
REVOKE ALL ON FUNCTION private.chat_can_delete(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.chat_can_delete(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.chat_can_delete(p_room uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$ SELECT private.chat_can_delete(p_room) $$;

CREATE OR REPLACE FUNCTION public.chat_delete_room(p_room uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_auto boolean;
BEGIN
  IF NOT private.chat_can_delete(p_room) THEN RETURN jsonb_build_object('ok', false, 'error', 'FORBIDDEN'); END IF;
  SELECT auto_key IS NOT NULL INTO v_auto FROM public.chat_rooms WHERE id = p_room;
  IF v_auto THEN
    DELETE FROM public.chat_messages WHERE room_id = p_room;
    UPDATE public.chat_rooms SET last_message_at = now() WHERE id = p_room;
  ELSE
    DELETE FROM public.chat_rooms WHERE id = p_room;  -- members and messages go with it
  END IF;
  RETURN jsonb_build_object('ok', true, 'cleared', v_auto);
END $$;
REVOKE ALL ON FUNCTION public.chat_can_delete(uuid), public.chat_delete_room(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.chat_can_delete(uuid), public.chat_delete_room(uuid) TO authenticated;

-- Whoever may delete the conversation may also remove its photos from the private folder (the app does this first).
DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS chat_photos_delete ON storage.objects';
    EXECUTE $p$CREATE POLICY chat_photos_delete ON storage.objects FOR DELETE TO authenticated
      USING (bucket_id = 'chat' AND ((storage.foldername(name))[2] = private.current_user_id()::text
             OR private.chat_can_delete(((storage.foldername(name))[1])::uuid)))$p$;
  END IF;
END $$;
