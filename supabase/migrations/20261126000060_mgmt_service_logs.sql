-- update-0060 (CHRIS Nov 26): owners and the GM add service log entries without photos and without a second sign-off,
-- and approve several entries at once. Entries they already added stop asking for photos.

CREATE OR REPLACE FUNCTION public.log_client_visit(p_branch uuid, p_date date, p_service uuid, p_amount_cents bigint, p_type text,
  p_employee uuid, p_partner uuid, p_note text, p_kind text, p_confirm boolean,
  p_client text, p_price_note text, p_folder uuid, p_photos jsonb, p_share boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_kind text := upper(coalesce(p_kind, 'PAID')); v_client text := nullif(btrim(coalesce(p_client, '')), '');
  v_pnote text := nullif(left(btrim(coalesce(p_price_note, '')), 300), ''); v_price bigint; v_photos jsonb := coalesce(p_photos, '[]'::jsonb);
  v_prefix text; ph jsonb; r jsonb; v_id uuid; v_pos integer := 0; v_storage boolean := to_regclass('storage.objects') IS NOT NULL;
  n_w integer; n_b integer; n_a integer; v_found boolean; v_mgmt boolean := private.is_management(private.current_user_id());
  v_due boolean := false; v_svc text; v_code text; e record;
BEGIN
  IF private.current_user_id() IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT private.has_role(ARRAY['OWNER','FINANCE','MANAGER','CASHIER','CLINICIAN'], p_branch) THEN RETURN private.deny(p_branch, 'service_log'); END IF;
  IF NOT public.can_log_services_now() THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_TIMED_IN'); END IF;
  IF v_client IS NULL OR length(v_client) < 2 OR length(v_client) > 120 THEN RETURN jsonb_build_object('ok', false, 'error', 'CLIENT_NAME_REQUIRED'); END IF;
  SELECT price_cents INTO v_price FROM public.services WHERE id = p_service AND organization_id = private.current_org_id();
  IF v_kind = 'PAID' AND v_price IS NOT NULL AND v_price > 0 AND p_amount_cents IS DISTINCT FROM v_price AND coalesce(length(v_pnote), 0) < 3 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'PRICE_NOTE_REQUIRED');
  END IF;
  -- Photos: in this branch's folder for this visit, at most 20, a kind each, and (where Storage is installed) already uploaded.
  IF jsonb_typeof(v_photos) <> 'array' OR jsonb_array_length(v_photos) > 20 OR p_folder IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST'); END IF;
  v_prefix := p_branch::text || '/' || p_folder::text || '/';
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
  SELECT count(*) FILTER (WHERE x ->> 'kind' = 'WAIVER'), count(*) FILTER (WHERE x ->> 'kind' = 'BEFORE'), count(*) FILTER (WHERE x ->> 'kind' = 'AFTER')
  INTO n_w, n_b, n_a FROM jsonb_array_elements(v_photos) x;
  -- update-0060 (CHRIS Nov 26): owners and the GM need no photos at all: their entries are never "photos missing".
  v_due := NOT v_mgmt AND v_kind IN ('PAID','BACKJOB') AND (n_w < 2 OR n_b < 1 OR n_a < 1);
  IF v_due AND NOT v_mgmt THEN
    IF n_w < 2 THEN RETURN jsonb_build_object('ok', false, 'error', 'WAIVER_PHOTOS_REQUIRED'); END IF;
    IF n_b < 1 OR n_a < 1 THEN RETURN jsonb_build_object('ok', false, 'error', 'BEFORE_AFTER_REQUIRED'); END IF;
  END IF;

  r := public.log_visit(p_branch, p_date, p_service, p_amount_cents, p_type, p_employee, p_partner, NULL, p_note, v_kind, p_confirm);
  IF NOT coalesce((r ->> 'ok')::boolean, false) THEN RETURN r; END IF;
  v_id := (r ->> 'id')::uuid;
  UPDATE public.service_logs SET client_name = v_client, list_price_cents = v_price, price_note = v_pnote,
    share_ok = coalesce(p_share, false), photo_folder = p_folder, photos_due = v_due WHERE id = v_id;
  FOR ph IN SELECT * FROM jsonb_array_elements(v_photos) LOOP
    INSERT INTO public.service_photos (organization_id, service_log_id, branch_id, kind, path, thumb_path, position, created_by)
    VALUES (private.current_org_id(), v_id, p_branch, ph ->> 'kind', ph ->> 'path', ph ->> 'thumb', v_pos, private.current_user_id());
    v_pos := v_pos + 1;
  END LOOP;
  IF v_due THEN PERFORM private.notify_photos_due(v_id); END IF;
  -- update-0060: an entry added by owners or the GM is approved right away (no second sign-off).
  IF v_mgmt AND r ->> 'state' = 'PENDING' THEN
    UPDATE public.service_logs SET state = 'APPROVED', decided_by = private.current_user_id(), decided_at = now() WHERE id = v_id AND state = 'PENDING';
    r := r || jsonb_build_object('state', 'APPROVED');
  END IF;
  RETURN r || jsonb_build_object('photos_due', v_due);
END $$;

-- Approve several entries at once (owners and the GM, or a branch manager for their branch). Same rules as one by one.
CREATE OR REPLACE FUNCTION public.approve_service_logs(p_logs uuid[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v uuid; r jsonb; n_ok integer := 0; n_skip integer := 0;
BEGIN
  IF private.current_user_id() IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF p_logs IS NULL OR cardinality(p_logs) = 0 OR cardinality(p_logs) > 300 THEN RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST'); END IF;
  FOREACH v IN ARRAY p_logs LOOP
    r := public.decide_service_log(v, true, NULL);
    IF coalesce((r ->> 'ok')::boolean, false) THEN n_ok := n_ok + 1; ELSE n_skip := n_skip + 1; END IF;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'approved', n_ok, 'skipped', n_skip);
END $$;
REVOKE ALL ON FUNCTION public.approve_service_logs(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_service_logs(uuid[]) TO authenticated;

-- Entries owners or the GM already added: no longer "photos missing" (their commission counts), and the reminders go.
DELETE FROM public.notifications n USING public.service_logs l
WHERE n.kind = 'PHOTOS_DUE' AND l.photos_due AND private.is_management(l.created_by) AND n.link LIKE '%&entry=' || l.id::text;
DO $$
BEGIN
  PERFORM set_config('hermosa.photo_sharing', 'on', true);
  UPDATE public.service_logs SET photos_due = false WHERE photos_due AND private.is_management(created_by);
  PERFORM set_config('hermosa.photo_sharing', 'off', true);
END $$;
