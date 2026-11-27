-- update-0093 (v0.93.0, CHRIS Nov 27):
--   1. Several services for one client in a single Service log entry. Each extra service is saved as its own line
--      of the same visit (same client, branch, date, people, photos), with the usual commission rules: the
--      service's set commission, or 5% of what was paid; a discount earns 5% of what was paid.
--   2. Photo changes on past entries (add, remove, replace, waivers included) wait for approval before they apply.
--      Replaced and removed files move to the entry's "old" folder; nothing is deleted.
--
-- Already run? This read-only check tells you (it changes nothing):
--   select case when exists (select 1 from pg_proc where proname = 'log_extra_service')
--     then 'ALREADY RUN: tick the box on your To-Do' else 'NOT RUN YET: run the rest of this file' end as result;

-- 1. Another service of the same visit. p_log = the main service line just saved.
CREATE OR REPLACE FUNCTION public.log_extra_service(p_log uuid, p_service uuid, p_amount_cents bigint, p_price_note text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid := private.current_user_id(); v_org uuid := private.current_org_id();
  l record; s record; r jsonb; v_id uuid; v_type text; v_mgmt boolean := private.is_management(private.current_user_id());
  v_note text := nullif(btrim(coalesce(p_price_note, '')), '');
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  SELECT * INTO l FROM public.service_logs WHERE id = p_log AND organization_id = v_org;
  IF NOT FOUND OR l.state = 'REJECTED' THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF l.created_by <> v_user AND NOT v_mgmt THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_ALLOWED'); END IF;
  IF coalesce(l.visit_kind, 'PAID') <> 'PAID' THEN RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST'); END IF;
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 THEN RETURN jsonb_build_object('ok', false, 'error', 'INVALID_AMOUNT'); END IF;
  -- Regular priced services only: not meds, not bundles with a session schedule, not promo items (no price).
  SELECT id, price_cents INTO s FROM public.services
   WHERE id = p_service AND organization_id = v_org AND active AND NOT is_meds AND coalesce(price_cents, 0) > 0
     AND (to_jsonb(services) -> 'session_prices') IS NOT DISTINCT FROM 'null'::jsonb;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'UNKNOWN_SERVICE'); END IF;
  IF p_amount_cents <> s.price_cents AND (v_note IS NULL OR length(v_note) < 3) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'PRICE_NOTE_REQUIRED');
  END IF;

  -- Same people and split as the main line: Solo, Lead + assist, or no commission.
  v_type := CASE WHEN l.commission_type = 'NONCOMMI' THEN 'NONCOMMI' WHEN l.assistant_id IS NOT NULL THEN 'LEAD' ELSE 'SOLO' END;
  r := public.log_visit(l.branch_id, l.service_date, p_service, p_amount_cents, v_type, l.performer_id, l.assistant_id,
    NULL, 'Same visit', 'PAID', true);
  IF NOT coalesce((r ->> 'ok')::boolean, false) THEN RETURN r; END IF;
  v_id := (r ->> 'id')::uuid;
  UPDATE public.service_logs SET client_name = l.client_name, list_price_cents = s.price_cents, photo_folder = l.photo_folder,
    photos_due = false, session_no = 1, price_note = v_note, booking_id = l.booking_id WHERE id = v_id;
  IF v_mgmt AND r ->> 'state' = 'PENDING' THEN
    UPDATE public.service_logs SET state = 'APPROVED', decided_by = v_user, decided_at = now() WHERE id = v_id AND state = 'PENDING';
    r := r || jsonb_build_object('state', 'APPROVED');
  END IF;
  RETURN r;
END $$;
REVOKE ALL ON FUNCTION public.log_extra_service(uuid, uuid, bigint, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.log_extra_service(uuid, uuid, bigint, text) TO authenticated;

-- 2. Photo changes on past entries. Old (replaced or removed) photos stay on the entry, marked archived, and show in
--    the client's folder under "Old". New files upload into the entry's own folder before the request is sent.
ALTER TABLE public.service_photos ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE public.service_photos ADD COLUMN IF NOT EXISTS archived_by uuid REFERENCES public.app_users(id);
ALTER TABLE public.service_photos ADD COLUMN IF NOT EXISTS archived_why text CHECK (archived_why IS NULL OR archived_why IN ('REPLACED','REMOVED'));

CREATE TABLE IF NOT EXISTS public.photo_change_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  service_log_id uuid NOT NULL REFERENCES public.service_logs(id) ON DELETE CASCADE,
  branch_id uuid NOT NULL REFERENCES public.branches(id),
  changes jsonb NOT NULL,   -- [{op: ADD|REMOVE|REPLACE, photo?: uuid, kind?: WAIVER|BEFORE|AFTER, path?: text, thumb?: text}]
  note text NOT NULL CHECK (length(btrim(note)) BETWEEN 3 AND 300),
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','APPROVED','REJECTED','CANCELLED')),
  requested_by uuid NOT NULL REFERENCES public.app_users(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES public.app_users(id),
  decided_at timestamptz,
  decision_note text CHECK (decision_note IS NULL OR length(decision_note) <= 300)
);
CREATE INDEX IF NOT EXISTS photo_change_requests_log ON public.photo_change_requests (service_log_id);
CREATE INDEX IF NOT EXISTS photo_change_requests_pending ON public.photo_change_requests (organization_id) WHERE state = 'PENDING';
ALTER TABLE public.photo_change_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.photo_change_requests FROM PUBLIC, anon, authenticated;

-- Who approves photo changes (CHRIS Nov 27): the owners and the GM.
CREATE OR REPLACE FUNCTION private.photo_approver() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT private.has_role(ARRAY['OWNER'], NULL) OR private.is_gm()
$$;
REVOKE ALL ON FUNCTION private.photo_approver() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.photo_approver() TO authenticated;

-- Pending new files can be opened by the person who sent them and by the approvers (to compare before deciding).
CREATE OR REPLACE FUNCTION private.can_open_client_photo(p_name text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.service_photos p JOIN public.service_logs l ON l.id = p.service_log_id
                 WHERE (p.path = p_name OR p.thumb_path = p_name) AND p.organization_id = private.current_org_id()
                   AND (private.can_see_archive(p.branch_id)
                        OR (private.can_see_social() AND l.share_ok AND p.kind <> 'WAIVER' AND p.archived_at IS NULL)))
      OR EXISTS (SELECT 1 FROM public.photo_change_requests r, jsonb_array_elements(r.changes) c
                 WHERE r.organization_id = private.current_org_id() AND (c ->> 'path' = p_name OR c ->> 'thumb' = p_name)
                   AND (r.requested_by = private.current_user_id() OR private.photo_approver()))
$$;
REVOKE ALL ON FUNCTION private.can_open_client_photo(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.can_open_client_photo(text) TO authenticated;

-- Apply an approved request: ADD inserts, REMOVE archives, REPLACE archives the old one and adds the new one in its place.
CREATE OR REPLACE FUNCTION private.apply_photo_changes(p_request uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.photo_change_requests%ROWTYPE; c jsonb; old public.service_photos%ROWTYPE; v_pos integer;
  v_user uuid := private.current_user_id(); n_w integer; n_b integer; n_a integer; l public.service_logs%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.photo_change_requests WHERE id = p_request;
  SELECT coalesce(max(position) + 1, 0) INTO v_pos FROM public.service_photos WHERE service_log_id = r.service_log_id;
  FOR c IN SELECT * FROM jsonb_array_elements(r.changes) LOOP
    IF c ->> 'op' IN ('REMOVE','REPLACE') THEN
      SELECT * INTO old FROM public.service_photos WHERE id = (c ->> 'photo')::uuid AND service_log_id = r.service_log_id AND archived_at IS NULL;
      IF FOUND THEN
        UPDATE public.service_photos SET archived_at = now(), archived_by = v_user,
          archived_why = CASE WHEN c ->> 'op' = 'REPLACE' THEN 'REPLACED' ELSE 'REMOVED' END WHERE id = old.id;
      END IF;
    END IF;
    IF c ->> 'op' IN ('ADD','REPLACE') THEN
      INSERT INTO public.service_photos (organization_id, service_log_id, branch_id, kind, path, thumb_path, position, created_by)
      VALUES (r.organization_id, r.service_log_id, r.branch_id,
              CASE WHEN c ->> 'op' = 'REPLACE' AND old.id IS NOT NULL THEN old.kind ELSE c ->> 'kind' END,
              c ->> 'path', c ->> 'thumb', CASE WHEN c ->> 'op' = 'REPLACE' AND old.id IS NOT NULL THEN old.position ELSE v_pos END, r.requested_by)
      ON CONFLICT (path) DO NOTHING;
      v_pos := v_pos + 1;
    END IF;
    old := NULL;
  END LOOP;
  -- Photos that complete an entry clear its "Photos missing" hold, as when they're added the usual way.
  SELECT * INTO l FROM public.service_logs WHERE id = r.service_log_id;
  SELECT count(*) FILTER (WHERE kind = 'WAIVER'), count(*) FILTER (WHERE kind = 'BEFORE'), count(*) FILTER (WHERE kind = 'AFTER')
    INTO n_w, n_b, n_a FROM public.service_photos WHERE service_log_id = r.service_log_id AND archived_at IS NULL;
  IF l.photos_due AND n_w >= 2 AND ((n_b >= 1 AND n_a >= 1) OR NOT coalesce(l.before_after, true)) THEN
    PERFORM set_config('hermosa.photo_sharing', 'on', true);
    UPDATE public.service_logs SET photos_due = false WHERE id = l.id;
    PERFORM set_config('hermosa.photo_sharing', 'off', true);
    UPDATE public.notifications SET read_at = now() WHERE kind = 'PHOTOS_DUE' AND read_at IS NULL AND link LIKE '%&entry=' || l.id::text;
  END IF;
END $$;
REVOKE ALL ON FUNCTION private.apply_photo_changes(uuid) FROM PUBLIC, anon, authenticated;

-- Staff ask for a change; owners' and the GM's own changes apply at once.
CREATE OR REPLACE FUNCTION public.request_photo_changes(p_log uuid, p_changes jsonb, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid := private.current_user_id(); l public.service_logs%ROWTYPE; c jsonb; v_prefix text; v_found boolean;
  v_storage boolean := to_regclass('storage.objects') IS NOT NULL; v_id uuid; v_note text := btrim(coalesce(p_note, ''));
  v_client text; v_seen uuid[] := '{}';
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  SELECT * INTO l FROM public.service_logs WHERE id = p_log AND organization_id = private.current_org_id();
  IF NOT FOUND OR l.state = 'REJECTED' THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF NOT (private.is_management(v_user) OR l.created_by = v_user
          OR EXISTS (SELECT 1 FROM public.employees e WHERE e.id IN (l.performer_id, l.assistant_id) AND e.app_user_id = v_user)) THEN
    RETURN private.deny(l.branch_id, 'service_log');
  END IF;
  IF length(v_note) < 3 THEN RETURN jsonb_build_object('ok', false, 'error', 'REASON_REQUIRED'); END IF;
  IF jsonb_typeof(p_changes) <> 'array' OR jsonb_array_length(p_changes) = 0 OR jsonb_array_length(p_changes) > 20 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
  END IF;
  IF l.photo_folder IS NULL THEN
    -- An entry without photos gets its folder now (the first ADD names it).
    l.photo_folder := (SELECT (regexp_match(c2 ->> 'path', '^[0-9a-f-]{36}/([0-9a-f-]{36})/'))[1]::uuid
                         FROM jsonb_array_elements(p_changes) c2 WHERE c2 ->> 'op' = 'ADD' LIMIT 1);
    IF l.photo_folder IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST'); END IF;
  END IF;
  v_prefix := l.branch_id::text || '/' || l.photo_folder::text || '/';
  FOR c IN SELECT * FROM jsonb_array_elements(p_changes) LOOP
    IF coalesce(c ->> 'op', '') NOT IN ('ADD','REMOVE','REPLACE') THEN RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST'); END IF;
    IF c ->> 'op' IN ('REMOVE','REPLACE') THEN
      IF coalesce(c ->> 'photo', '') !~ '^[0-9a-f-]{36}$'
         OR NOT EXISTS (SELECT 1 FROM public.service_photos WHERE id = (c ->> 'photo')::uuid AND service_log_id = p_log AND archived_at IS NULL)
         OR (c ->> 'photo')::uuid = ANY (v_seen) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
      END IF;
      v_seen := v_seen || (c ->> 'photo')::uuid;
    END IF;
    IF c ->> 'op' = 'ADD' AND coalesce(c ->> 'kind', '') NOT IN ('WAIVER','BEFORE','AFTER') THEN RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST'); END IF;
    IF c ->> 'op' IN ('ADD','REPLACE') THEN
      IF coalesce(c ->> 'path', '') !~ ('^' || v_prefix || '[a-z]+-[0-9a-f-]{36}\.(jpg|jpeg|png|webp|heic|heif)$')
         OR (c ->> 'thumb' IS NOT NULL AND (c ->> 'thumb') !~ ('^' || v_prefix || 'thumb-[0-9a-f-]{36}\.jpg$')) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
      END IF;
      IF v_storage THEN
        EXECUTE 'SELECT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = ''client-photos'' AND o.name = $1)' INTO v_found USING c ->> 'path';
        IF NOT v_found THEN RETURN jsonb_build_object('ok', false, 'error', 'PHOTO_NOT_UPLOADED'); END IF;
      END IF;
    END IF;
  END LOOP;
  IF l.photo_folder IS DISTINCT FROM (SELECT photo_folder FROM public.service_logs WHERE id = p_log) THEN
    PERFORM set_config('hermosa.photo_sharing', 'on', true);
    UPDATE public.service_logs SET photo_folder = l.photo_folder WHERE id = p_log;
    PERFORM set_config('hermosa.photo_sharing', 'off', true);
  END IF;

  INSERT INTO public.photo_change_requests (organization_id, service_log_id, branch_id, changes, note, requested_by)
  VALUES (l.organization_id, p_log, l.branch_id, p_changes, v_note, v_user) RETURNING id INTO v_id;
  IF private.photo_approver() THEN
    UPDATE public.photo_change_requests SET state = 'APPROVED', decided_by = v_user, decided_at = now() WHERE id = v_id;
    PERFORM private.apply_photo_changes(v_id);
  END IF;
  -- CHRIS Nov 27: every Service log photo edit shows in management's notifications (owners and the GM).
  v_client := coalesce(l.client_name, 'a client');
  INSERT INTO public.notifications (organization_id, user_id, kind, title, body, link, created_by)
  SELECT DISTINCT l.organization_id, u.id, CASE WHEN private.photo_approver() THEN 'PHOTO_CHANGED' ELSE 'PHOTO_CHANGE' END,
    CASE WHEN private.photo_approver() THEN 'Service log photos changed' ELSE 'Photo change to approve' END,
    left(format('%s %s the photos of %s (%s, %s): %s', coalesce((SELECT display_name FROM public.app_users WHERE id = v_user), 'Staff'),
      CASE WHEN private.photo_approver() THEN 'changed' ELSE 'asks to change' END,
      v_client, to_char(l.service_date, 'Mon DD'), (SELECT name FROM public.branches WHERE id = l.branch_id), v_note), 1000),
    '/services/photo-changes', v_user
  FROM public.app_users u JOIN public.role_grants g ON g.user_id = u.id
  WHERE u.organization_id = l.organization_id AND u.active AND g.revoked_at IS NULL AND g.branch_id IS NULL
    AND g.role_code IN ('OWNER','MANAGER') AND u.id <> v_user;
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'applied', private.photo_approver());
END $$;
REVOKE ALL ON FUNCTION public.request_photo_changes(uuid, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_photo_changes(uuid, jsonb, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.decide_photo_change(p_id uuid, p_approve boolean, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id(); r public.photo_change_requests%ROWTYPE; v_client text;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT private.photo_approver() THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_ALLOWED'); END IF;
  SELECT * INTO r FROM public.photo_change_requests WHERE id = p_id AND organization_id = private.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF r.state <> 'PENDING' THEN RETURN jsonb_build_object('ok', false, 'error', 'ALREADY_DECIDED'); END IF;
  UPDATE public.photo_change_requests SET state = CASE WHEN p_approve THEN 'APPROVED' ELSE 'REJECTED' END, decided_by = v_user,
    decided_at = now(), decision_note = nullif(left(btrim(coalesce(p_note, '')), 300), '') WHERE id = p_id;
  IF p_approve THEN PERFORM private.apply_photo_changes(p_id); END IF;
  -- The other approvers' notices clear; the person who asked is told.
  UPDATE public.notifications SET read_at = now() WHERE kind = 'PHOTO_CHANGE' AND read_at IS NULL
    AND organization_id = r.organization_id AND NOT EXISTS (SELECT 1 FROM public.photo_change_requests x WHERE x.organization_id = r.organization_id AND x.state = 'PENDING');
  SELECT coalesce(client_name, 'the client') INTO v_client FROM public.service_logs WHERE id = r.service_log_id;
  INSERT INTO public.notifications (organization_id, user_id, kind, title, body, link, created_by)
  VALUES (r.organization_id, r.requested_by, 'PHOTO_CHANGE_DONE',
    CASE WHEN p_approve THEN 'Photo change approved' ELSE 'Photo change not approved' END,
    left(format('Photos of %s: %s', v_client, coalesce(nullif(btrim(coalesce(p_note, '')), ''), CASE WHEN p_approve THEN 'saved.' ELSE 'no change made.' END)), 1000),
    '/services/photo-changes', v_user);
  RETURN jsonb_build_object('ok', true);
END $$;
REVOKE ALL ON FUNCTION public.decide_photo_change(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.decide_photo_change(uuid, boolean, text) TO authenticated;

-- The requester can take back a request still waiting.
CREATE OR REPLACE FUNCTION public.cancel_photo_change(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.photo_change_requests SET state = 'CANCELLED', decided_at = now()
   WHERE id = p_id AND requested_by = private.current_user_id() AND state = 'PENDING';
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  RETURN jsonb_build_object('ok', true);
END $$;
REVOKE ALL ON FUNCTION public.cancel_photo_change(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_photo_change(uuid) TO authenticated;

-- The entry's current photos (for the Edit photos panel) and any request waiting on it.
CREATE OR REPLACE FUNCTION public.entry_photos(p_log uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object('ok', true, 'branch', l.branch_id, 'folder', l.photo_folder,
    'photos', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'kind', p.kind, 'path', p.path, 'thumb', p.thumb_path)
                 ORDER BY CASE p.kind WHEN 'BEFORE' THEN 1 WHEN 'AFTER' THEN 2 ELSE 3 END, p.position), '[]'::jsonb)
               FROM public.service_photos p WHERE p.service_log_id = l.id AND p.archived_at IS NULL),
    'pending', (SELECT jsonb_build_object('id', r.id, 'note', r.note, 'mine', r.requested_by = private.current_user_id(), 'count', jsonb_array_length(r.changes))
                FROM public.photo_change_requests r WHERE r.service_log_id = l.id AND r.state = 'PENDING' ORDER BY r.requested_at DESC LIMIT 1))
  FROM public.service_logs l
  WHERE l.id = p_log AND l.organization_id = private.current_org_id() AND private.can_see_archive(l.branch_id)
$$;
REVOKE ALL ON FUNCTION public.entry_photos(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.entry_photos(uuid) TO authenticated;

-- Requests for the approvers' page (pending first, then the last 30 decided), with each change's old and new file.
CREATE OR REPLACE FUNCTION public.photo_change_list() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(jsonb_agg(x.j ORDER BY x.pending DESC, x.at DESC), '[]'::jsonb) FROM (
    SELECT r.state = 'PENDING' AS pending, r.requested_at AS at, jsonb_build_object(
      'id', r.id, 'state', r.state, 'note', r.note, 'decision_note', r.decision_note, 'at', r.requested_at, 'decided_at', r.decided_at,
      'by', (SELECT display_name FROM public.app_users WHERE id = r.requested_by), 'decider', (SELECT display_name FROM public.app_users WHERE id = r.decided_by),
      'mine', r.requested_by = private.current_user_id(),
      'log', l.id, 'date', l.service_date, 'client', l.client_name, 'service', sv.name, 'branch', b.name,
      'changes', (SELECT jsonb_agg(c || jsonb_build_object('old', (SELECT jsonb_build_object('kind', p.kind, 'path', p.path, 'thumb', p.thumb_path)
                                                           FROM public.service_photos p WHERE p.id::text = c ->> 'photo')))
                  FROM jsonb_array_elements(r.changes) c)) AS j
    FROM public.photo_change_requests r
    JOIN public.service_logs l ON l.id = r.service_log_id
    LEFT JOIN public.services sv ON sv.id = l.service_id
    LEFT JOIN public.branches b ON b.id = l.branch_id
    WHERE r.organization_id = private.current_org_id() AND r.state <> 'CANCELLED'
      AND (private.photo_approver() OR r.requested_by = private.current_user_id())
      AND (r.state = 'PENDING' OR r.requested_at > now() - interval '30 days')
    ORDER BY r.state = 'PENDING' DESC, r.requested_at DESC LIMIT 60) x
$$;
REVOKE ALL ON FUNCTION public.photo_change_list() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.photo_change_list() TO authenticated;

-- How many photo changes wait for the owners / the GM (their Home To do).
CREATE OR REPLACE FUNCTION public.photo_changes_pending() RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN private.photo_approver() THEN (SELECT count(*)::integer FROM public.photo_change_requests
              WHERE organization_id = private.current_org_id() AND state = 'PENDING') ELSE 0 END
$$;
REVOKE ALL ON FUNCTION public.photo_changes_pending() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.photo_changes_pending() TO authenticated;

-- client_photo_folders as in update-0053, with replaced / removed photos apart ("old").
CREATE OR REPLACE FUNCTION public.client_photo_folders(p_month date, p_branch uuid, p_social boolean) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH m AS (SELECT date_trunc('month', coalesce(p_month, (now() AT TIME ZONE 'Asia/Manila')::date))::date AS s)
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'date', l.service_date, 'client', l.client_name, 'service', sv.name,
      'branch_id', l.branch_id, 'branch', b.name, 'lead', pe.full_name, 'assist', ae.full_name, 'type', l.commission_type,
      'kind', l.visit_kind, 'share_ok', l.share_ok, 'state', l.state,
      'photos', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'kind', p.kind, 'path', p.path, 'thumb', p.thumb_path)
                   ORDER BY CASE p.kind WHEN 'BEFORE' THEN 1 WHEN 'AFTER' THEN 2 ELSE 3 END, p.position), '[]'::jsonb)
                 FROM public.service_photos p WHERE p.service_log_id = l.id AND p.archived_at IS NULL AND (NOT coalesce(p_social, false) OR p.kind <> 'WAIVER')),
      -- update-0093: replaced or removed photos, shown in the client's folder under "Old" (archive only).
      'old', CASE WHEN coalesce(p_social, false) THEN '[]'::jsonb ELSE (SELECT coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'kind', p.kind, 'path', p.path,
                   'thumb', p.thumb_path, 'why', p.archived_why, 'at', p.archived_at) ORDER BY p.archived_at DESC), '[]'::jsonb)
                 FROM public.service_photos p WHERE p.service_log_id = l.id AND p.archived_at IS NOT NULL) END)
    ORDER BY l.service_date DESC, l.created_at DESC), '[]'::jsonb)
  FROM public.service_logs l CROSS JOIN m
  LEFT JOIN public.services sv ON sv.id = l.service_id
  LEFT JOIN public.branches b ON b.id = l.branch_id
  LEFT JOIN public.employees pe ON pe.id = l.performer_id
  LEFT JOIN public.employees ae ON ae.id = l.assistant_id
  WHERE l.organization_id = private.current_org_id() AND l.client_name IS NOT NULL
    AND l.service_date >= m.s AND l.service_date < (m.s + interval '1 month')::date
    AND (p_branch IS NULL OR l.branch_id = p_branch) AND l.state <> 'REJECTED'
    AND EXISTS (SELECT 1 FROM public.service_photos p WHERE p.service_log_id = l.id
                AND (NOT coalesce(p_social, false) OR p.archived_at IS NULL))
    AND CASE WHEN coalesce(p_social, false) THEN private.can_see_social() AND l.share_ok ELSE private.can_see_archive(l.branch_id) END
$$;
REVOKE ALL ON FUNCTION public.client_photo_folders(date, uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.client_photo_folders(date, uuid, boolean) TO authenticated;

-- add_visit_photos as in update-0054; archived photos don't count toward a complete entry.
CREATE OR REPLACE FUNCTION public.add_visit_photos(p_log uuid, p_folder uuid, p_photos jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid := private.current_user_id(); l public.service_logs%ROWTYPE; v_photos jsonb := coalesce(p_photos, '[]'::jsonb);
  v_folder uuid; v_prefix text; ph jsonb; v_found boolean; v_storage boolean := to_regclass('storage.objects') IS NOT NULL;
  v_pos integer; n_w integer; n_b integer; n_a integer;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  SELECT * INTO l FROM public.service_logs WHERE id = p_log AND organization_id = private.current_org_id();
  IF NOT FOUND OR l.state = 'REJECTED' THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF NOT (private.is_management(v_user) OR l.created_by = v_user
          OR EXISTS (SELECT 1 FROM public.employees e WHERE e.id IN (l.performer_id, l.assistant_id) AND e.app_user_id = v_user)) THEN
    RETURN private.deny(l.branch_id, 'service_log');
  END IF;
  v_folder := coalesce(l.photo_folder, p_folder);
  IF v_folder IS NULL OR jsonb_typeof(v_photos) <> 'array' OR jsonb_array_length(v_photos) = 0 OR jsonb_array_length(v_photos) > 20 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
  END IF;
  v_prefix := l.branch_id::text || '/' || v_folder::text || '/';
  FOR ph IN SELECT * FROM jsonb_array_elements(v_photos) LOOP
    IF coalesce(ph ->> 'kind', '') NOT IN ('WAIVER','BEFORE','AFTER')
       OR coalesce(ph ->> 'path', '') !~ ('^' || v_prefix || '[a-z]+-[0-9a-f-]{36}\.(jpg|jpeg|png|webp|heic|heif)$')
       OR (ph ->> 'thumb' IS NOT NULL AND (ph ->> 'thumb') !~ ('^' || v_prefix || 'thumb-[0-9a-f-]{36}\.jpg$')) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
    END IF;
    IF v_storage THEN
      EXECUTE 'SELECT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = ''client-photos'' AND o.name = $1)' INTO v_found USING ph ->> 'path';
      IF NOT v_found THEN RETURN jsonb_build_object('ok', false, 'error', 'PHOTO_NOT_UPLOADED'); END IF;
    END IF;
  END LOOP;
  SELECT coalesce(max(position) + 1, 0) INTO v_pos FROM public.service_photos WHERE service_log_id = p_log;
  FOR ph IN SELECT * FROM jsonb_array_elements(v_photos) LOOP
    INSERT INTO public.service_photos (organization_id, service_log_id, branch_id, kind, path, thumb_path, position, created_by)
    VALUES (l.organization_id, p_log, l.branch_id, ph ->> 'kind', ph ->> 'path', ph ->> 'thumb', v_pos, v_user)
    ON CONFLICT (path) DO NOTHING;
    v_pos := v_pos + 1;
  END LOOP;
  SELECT count(*) FILTER (WHERE kind = 'WAIVER'), count(*) FILTER (WHERE kind = 'BEFORE'), count(*) FILTER (WHERE kind = 'AFTER')
  INTO n_w, n_b, n_a FROM public.service_photos WHERE service_log_id = p_log AND archived_at IS NULL;
  PERFORM set_config('hermosa.photo_sharing', 'on', true);
  UPDATE public.service_logs SET photo_folder = v_folder, photos_due = l.photos_due AND NOT (n_w >= 2 AND n_b >= 1 AND n_a >= 1) WHERE id = p_log;
  PERFORM set_config('hermosa.photo_sharing', 'off', true);
  IF l.photos_due AND n_w >= 2 AND n_b >= 1 AND n_a >= 1 THEN
    UPDATE public.notifications SET read_at = now() WHERE kind = 'PHOTOS_DUE' AND read_at IS NULL AND link LIKE '%&entry=' || p_log::text;
  END IF;
  RETURN jsonb_build_object('ok', true, 'complete', n_w >= 2 AND n_b >= 1 AND n_a >= 1, 'waivers', n_w, 'before', n_b, 'after', n_a);
END $$;
REVOKE ALL ON FUNCTION public.add_visit_photos(uuid, uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_visit_photos(uuid, uuid, jsonb) TO authenticated;

SELECT 'update-0093 is installed' AS result;
