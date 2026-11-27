-- Hermosa OS update-0097 (CHRIS Nov 27): staff rotate between branches, so where they work today comes from their time-in.
--   1. Time in asks "Branch assigned today" (the 4 clinics, default = home branch). CHRIS: "if location data is
--      available, location data must supersede both selection and home branch": when the phone's location is within
--      300 m of a clinic, that clinic is the branch on record. No location = the pick stands (flagged as before).
--   2. Service log: for today's entries, "Done by" and "Assisted by" must have timed in at that branch today (if they
--      timed in anywhere today). Owners and the GM can still log or correct anything.
-- Safe to run again.
-- CHECK FIRST (changes nothing):
-- select case when exists (select 1 from pg_proc where proname = 'staff_branches_today') then 'ALREADY RUN: tick the box on your To-Do' else 'NOT RUN YET: run the rest of this file' end as result;

-- Branches an employee timed in at on a day (empty = didn't time in).
CREATE OR REPLACE FUNCTION private.time_in_branches(p_emp uuid, p_date date) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(array_agg(DISTINCT t.branch_id), '{}') FROM public.time_punches t
  WHERE t.employee_id = p_emp AND t.work_date = p_date AND t.kind = 'IN';
$$;
REVOKE ALL ON FUNCTION private.time_in_branches(uuid, date) FROM PUBLIC, anon, authenticated;

-- Everyone's time-in branches today, for the Service log staff lists: {"<employee id>": ["<branch id>", ...]}.
CREATE OR REPLACE FUNCTION public.staff_branches_today() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(jsonb_object_agg(x.employee_id, x.b), '{}'::jsonb)
  FROM (SELECT t.employee_id, jsonb_agg(DISTINCT t.branch_id) AS b FROM public.time_punches t
        WHERE t.organization_id = private.current_org_id() AND t.kind = 'IN'
          AND t.work_date = (now() AT TIME ZONE 'Asia/Manila')::date
        GROUP BY t.employee_id) x
  WHERE private.current_user_id() IS NOT NULL;
$$;
REVOKE ALL ON FUNCTION public.staff_branches_today() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_branches_today() TO authenticated;

-- Time in / out (update-0038 version) + the phone's location beats the pick when it is at a clinic.
CREATE OR REPLACE FUNCTION public.clock_punch(p_kind text, p_branch uuid, p_photo text, p_lat double precision, p_lng double precision,
  p_accuracy integer, p_photo_taken_at timestamptz DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id(); v_emp uuid := private.my_employee_id(); v_kind text := upper(coalesce(p_kind, ''));
  v_date date := (now() AT TIME ZONE 'Asia/Manila')::date; br public.branches%ROWTYPE; v_last text; v_id uuid; v_dist integer;
  v_taken timestamptz := p_photo_taken_at; v_branch uuid := p_branch; v_near uuid; v_near_m integer; v_moved boolean := false;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF v_emp IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NO_EMPLOYEE_RECORD'); END IF;
  IF v_kind NOT IN ('IN','OUT') THEN RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST'); END IF;
  SELECT * INTO br FROM public.branches WHERE id = p_branch AND organization_id = private.current_org_id() AND kind IN ('CLINIC','WFH') AND active;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'UNKNOWN_BRANCH'); END IF;
  IF p_photo IS NULL OR p_photo !~ ('^' || v_user::text || '/[0-9a-f-]{36}\.jpg$') THEN RETURN jsonb_build_object('ok', false, 'error', 'PHOTO_REQUIRED'); END IF;
  IF v_taken IS NOT NULL AND abs(extract(epoch FROM (v_taken - now()))) > 400 * 86400 THEN v_taken := NULL; END IF;
  SELECT kind INTO v_last FROM public.time_punches WHERE employee_id = v_emp AND work_date = v_date ORDER BY punched_at DESC LIMIT 1;
  IF v_kind = 'IN' AND v_last = 'IN' THEN RETURN jsonb_build_object('ok', false, 'error', 'ALREADY_IN'); END IF;
  IF v_kind = 'OUT' AND v_last IS DISTINCT FROM 'IN' THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_IN'); END IF;
  -- update-0097: at a clinic (within 300 m of its saved location), that clinic is the branch on record.
  IF br.kind = 'CLINIC' AND p_lat IS NOT NULL AND p_lng IS NOT NULL THEN
    SELECT b.id, private.meters(p_lat, p_lng, b.lat, b.lng) INTO v_near, v_near_m FROM public.branches b
     WHERE b.organization_id = br.organization_id AND b.kind = 'CLINIC' AND b.active AND b.lat IS NOT NULL AND b.lng IS NOT NULL
     ORDER BY private.meters(p_lat, p_lng, b.lat, b.lng) LIMIT 1;
    IF v_near IS NOT NULL AND v_near_m <= 300 AND v_near <> p_branch THEN
      v_branch := v_near; v_moved := true;
      SELECT * INTO br FROM public.branches WHERE id = v_near;
    END IF;
  END IF;
  IF p_lat IS NOT NULL AND p_lng IS NOT NULL AND br.lat IS NOT NULL THEN v_dist := private.meters(p_lat, p_lng, br.lat, br.lng); END IF;
  INSERT INTO public.time_punches (organization_id, employee_id, user_id, branch_id, kind, work_date, photo_path, lat, lng, accuracy_m, distance_m, photo_taken_at)
  VALUES (private.current_org_id(), v_emp, v_user, v_branch, v_kind, v_date, p_photo, p_lat, p_lng, p_accuracy, v_dist, v_taken)
  RETURNING id INTO v_id;
  IF v_moved THEN
    PERFORM private.audit(v_branch, 'TIME_PUNCH_BRANCH_BY_LOCATION', 'time_punch', v_id::text,
      jsonb_build_object('picked', p_branch), jsonb_build_object('branch', v_branch, 'meters', v_near_m));
  END IF;
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'kind', v_kind, 'at', now(), 'distance_m', v_dist,
    'branch_id', v_branch, 'branch_name', br.name, 'moved', v_moved);
END $$;
REVOKE ALL ON FUNCTION public.clock_punch(text, uuid, text, double precision, double precision, integer, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.clock_punch(text, uuid, text, double precision, double precision, integer, timestamptz) TO authenticated;

-- Today's entries by staff: Done by / Assisted by must have timed in at this branch (when they timed in anywhere).
CREATE OR REPLACE FUNCTION private.service_log_branch_today() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_at uuid[];
BEGIN
  IF NEW.service_date <> (now() AT TIME ZONE 'Asia/Manila')::date OR NEW.created_by IS NULL
     OR private.is_management(NEW.created_by) THEN RETURN NEW; END IF;
  v_at := private.time_in_branches(NEW.performer_id, NEW.service_date);
  IF cardinality(v_at) > 0 AND NOT (NEW.branch_id = ANY (v_at)) THEN RAISE EXCEPTION 'WRONG_BRANCH_TODAY'; END IF;
  IF NEW.assistant_id IS NOT NULL THEN
    v_at := private.time_in_branches(NEW.assistant_id, NEW.service_date);
    IF cardinality(v_at) > 0 AND NOT (NEW.branch_id = ANY (v_at)) THEN RAISE EXCEPTION 'WRONG_BRANCH_TODAY'; END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS service_logs_branch_today ON public.service_logs;
CREATE TRIGGER service_logs_branch_today BEFORE INSERT ON public.service_logs FOR EACH ROW EXECUTE FUNCTION private.service_log_branch_today();

SELECT 'update-0097 is installed' AS result;
