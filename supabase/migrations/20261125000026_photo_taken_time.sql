-- Time-in photos: keep the time the phone says the photo was taken (from the photo file itself),
-- next to the server time. The server time stays the official time; a big gap means an old photo.
ALTER TABLE public.time_punches ADD COLUMN IF NOT EXISTS photo_taken_at timestamptz;

DROP FUNCTION IF EXISTS public.clock_punch(text, uuid, text, double precision, double precision, integer);
CREATE OR REPLACE FUNCTION public.clock_punch(p_kind text, p_branch uuid, p_photo text, p_lat double precision, p_lng double precision,
  p_accuracy integer, p_photo_taken_at timestamptz DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id(); v_emp uuid := private.my_employee_id(); v_kind text := upper(coalesce(p_kind, ''));
  v_date date := (now() AT TIME ZONE 'Asia/Manila')::date; br public.branches%ROWTYPE; v_last text; v_id uuid; v_dist integer;
  v_taken timestamptz := p_photo_taken_at;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF v_emp IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NO_EMPLOYEE_RECORD'); END IF;
  IF v_kind NOT IN ('IN','OUT') THEN RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST'); END IF;
  SELECT * INTO br FROM public.branches WHERE id = p_branch AND organization_id = private.current_org_id() AND kind = 'CLINIC' AND active;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'UNKNOWN_BRANCH'); END IF;
  IF p_photo IS NULL OR p_photo !~ ('^' || v_user::text || '/[0-9a-f-]{36}\.jpg$') THEN RETURN jsonb_build_object('ok', false, 'error', 'PHOTO_REQUIRED'); END IF;
  -- A photo time years off is a phone with a wrong clock or a broken file: keep it out rather than store nonsense.
  IF v_taken IS NOT NULL AND abs(extract(epoch FROM (v_taken - now()))) > 400 * 86400 THEN v_taken := NULL; END IF;
  SELECT kind INTO v_last FROM public.time_punches WHERE employee_id = v_emp AND work_date = v_date ORDER BY punched_at DESC LIMIT 1;
  IF v_kind = 'IN' AND v_last = 'IN' THEN RETURN jsonb_build_object('ok', false, 'error', 'ALREADY_IN'); END IF;
  IF v_kind = 'OUT' AND v_last IS DISTINCT FROM 'IN' THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_IN'); END IF;
  IF p_lat IS NOT NULL AND p_lng IS NOT NULL AND br.lat IS NOT NULL THEN v_dist := private.meters(p_lat, p_lng, br.lat, br.lng); END IF;
  INSERT INTO public.time_punches (organization_id, employee_id, user_id, branch_id, kind, work_date, photo_path, lat, lng, accuracy_m, distance_m, photo_taken_at)
  VALUES (private.current_org_id(), v_emp, v_user, p_branch, v_kind, v_date, p_photo, p_lat, p_lng, p_accuracy, v_dist, v_taken)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'kind', v_kind, 'at', now(), 'distance_m', v_dist);
END $$;
REVOKE ALL ON FUNCTION public.clock_punch(text, uuid, text, double precision, double precision, integer, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.clock_punch(text, uuid, text, double precision, double precision, integer, timestamptz) TO authenticated;
