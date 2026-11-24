-- HERMOSA OS 0024: schedule by branch, like the owner's weekly sheet (owner sample 2026-11-25).
-- Safe to run more than once.
-- * The clinic plans by branch: each day, who is at Main, Fairview, SMB and Marikina, who is Off, and who is on
--   VL (vacation leave), SL (sick leave) or Absent. People move between branches through the week.
-- * A manager edits a whole day at once, and can start a week by copying last week.

ALTER TABLE public.shifts ADD COLUMN IF NOT EXISTS leave_type text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shifts_leave_type_check') THEN
    ALTER TABLE public.shifts ADD CONSTRAINT shifts_leave_type_check CHECK (leave_type IS NULL OR (leave_type IN ('VL','SL','ABSENT') AND is_off));
  END IF;
END $$;

-- Saving a day clears any leave on it (save_day sets the leave again right after).
CREATE OR REPLACE FUNCTION public.save_shift(p_employee uuid, p_date date, p_off boolean, p_branch uuid, p_start time, p_end time, p_note text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE old public.shifts%ROWTYPE; v_found boolean;
BEGIN
  IF private.current_user_id() IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT private.can_schedule(p_employee) THEN RETURN private.deny(NULL, 'schedule'); END IF;
  IF p_date IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'INVALID_DATE'); END IF;
  IF NOT coalesce(p_off, false) AND (p_start IS NULL OR p_end IS NULL OR p_end <= p_start
       OR NOT EXISTS (SELECT 1 FROM public.branches WHERE id = p_branch AND organization_id = private.current_org_id() AND kind = 'CLINIC' AND active)) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
  END IF;
  SELECT * INTO old FROM public.shifts WHERE employee_id = p_employee AND work_date = p_date FOR UPDATE;
  v_found := FOUND;
  INSERT INTO public.shifts (organization_id, employee_id, work_date, is_off, branch_id, start_time, end_time, state, note, updated_by)
  VALUES (private.current_org_id(), p_employee, p_date, coalesce(p_off, false),
          CASE WHEN p_off THEN NULL ELSE p_branch END, CASE WHEN p_off THEN NULL ELSE p_start END, CASE WHEN p_off THEN NULL ELSE p_end END,
          'DRAFT', nullif(btrim(coalesce(p_note, '')), ''), private.current_user_id())
  ON CONFLICT (employee_id, work_date) DO UPDATE SET is_off = excluded.is_off, branch_id = excluded.branch_id,
    start_time = excluded.start_time, end_time = excluded.end_time, note = excluded.note, leave_type = NULL,
    updated_by = excluded.updated_by, updated_at = now();
  IF v_found AND old.state = 'PUBLISHED' THEN
    UPDATE public.shifts SET state = 'PUBLISHED' WHERE employee_id = p_employee AND work_date = p_date;
    PERFORM private.notify_employee(p_employee, 'SCHEDULE_CHANGED', 'Your schedule changed',
      to_char(p_date, 'Dy, Mon FMDD') || ': ' || CASE WHEN p_off THEN 'Day off'
        ELSE (SELECT name FROM public.branches WHERE id = p_branch) || ', ' || to_char(p_start, 'FMHH12:MI AM') || ' to ' || to_char(p_end, 'FMHH12:MI AM') END || '.',
      '/schedule?week=' || to_char(date_trunc('week', p_date), 'YYYY-MM-DD'));
  END IF;
  PERFORM private.audit(NULL, 'SHIFT_SAVED', 'shift', p_employee::text || ':' || p_date,
    CASE WHEN v_found THEN to_jsonb(old) END, jsonb_build_object('off', p_off, 'branch', p_branch, 'start', p_start, 'end', p_end));
  RETURN jsonb_build_object('ok', true);
END $$;

-- Save one whole day: p_rows = [{employee, status: branch uuid | 'OFF' | 'VL' | 'SL' | 'ABSENT', start, end}].
-- Each person goes through save_shift (same checks and notices); people not listed are left as they are.
CREATE OR REPLACE FUNCTION public.save_day(p_date date, p_rows jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r jsonb; v_emp uuid; v_status text; v_off boolean; v_res jsonb; v_note text; v_leave text; v_n integer := 0;
BEGIN
  IF private.current_user_id() IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF p_date IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) > 100 THEN RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST'); END IF;
  FOR r IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    v_emp := (r ->> 'employee')::uuid;
    v_status := coalesce(r ->> 'status', '');
    IF upper(v_status) IN ('OFF','VL','SL','ABSENT') THEN v_status := upper(v_status); ELSE v_status := lower(v_status); END IF;
    IF NOT private.can_schedule(v_emp) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
    v_off := v_status IN ('OFF','VL','SL','ABSENT');
    v_leave := CASE WHEN v_status IN ('VL','SL','ABSENT') THEN v_status END;
    -- Unchanged days are skipped so nobody gets a notice for nothing.
    IF EXISTS (SELECT 1 FROM public.shifts s WHERE s.employee_id = v_emp AND s.work_date = p_date
               AND s.is_off = v_off AND s.leave_type IS NOT DISTINCT FROM v_leave
               AND (v_off OR (s.branch_id::text = v_status AND s.start_time = (r ->> 'start')::time AND s.end_time = (r ->> 'end')::time))) THEN
      CONTINUE;
    END IF;
    SELECT note INTO v_note FROM public.shifts WHERE employee_id = v_emp AND work_date = p_date;
    v_res := public.save_shift(v_emp, p_date, v_off, CASE WHEN v_off THEN NULL ELSE v_status::uuid END,
                               CASE WHEN v_off THEN NULL ELSE (r ->> 'start')::time END, CASE WHEN v_off THEN NULL ELSE (r ->> 'end')::time END, v_note);
    IF NOT (v_res ->> 'ok')::boolean THEN RAISE EXCEPTION '%', coalesce(v_res ->> 'error', 'BAD_REQUEST'); END IF;
    UPDATE public.shifts SET leave_type = v_leave WHERE employee_id = v_emp AND work_date = p_date;
    v_n := v_n + 1;
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'saved', v_n);
EXCEPTION
  WHEN invalid_text_representation THEN RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
  WHEN raise_exception THEN RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END $$;

-- Start a week from the week before (as a draft). Days already planned are kept; leave days come over as Off.
CREATE OR REPLACE FUNCTION public.copy_last_week(p_monday date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_n integer;
BEGIN
  IF private.current_user_id() IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF p_monday IS NULL OR extract(isodow FROM p_monday) <> 1 THEN RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST'); END IF;
  INSERT INTO public.shifts (organization_id, employee_id, work_date, is_off, branch_id, start_time, end_time, state, updated_by)
  SELECT s.organization_id, s.employee_id, s.work_date + 7, s.is_off, s.branch_id, s.start_time, s.end_time, 'DRAFT', private.current_user_id()
  FROM public.shifts s JOIN public.employees e ON e.id = s.employee_id AND e.active
  WHERE s.organization_id = private.current_org_id() AND s.work_date BETWEEN p_monday - 7 AND p_monday - 1 AND private.can_schedule(s.employee_id)
  ON CONFLICT (employee_id, work_date) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM private.audit(NULL, 'SCHEDULE_COPIED', 'schedule_week', p_monday::text, NULL, jsonb_build_object('days', v_n));
  RETURN jsonb_build_object('ok', true, 'created', v_n);
END $$;

-- On Duty and the week view now say which kind of leave.
CREATE OR REPLACE FUNCTION public.on_duty(p_date date) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH people AS (
    SELECT s.employee_id, s.branch_id, s.start_time, s.end_time, s.is_off, s.note, s.leave_type FROM public.shifts s
    WHERE s.organization_id = private.current_org_id() AND s.work_date = p_date AND s.state = 'PUBLISHED'
    UNION
    SELECT DISTINCT ON (t.employee_id) t.employee_id, t.branch_id, NULL::time, NULL::time, false, 'Not on the schedule', NULL::text
    FROM public.time_punches t
    WHERE t.organization_id = private.current_org_id() AND t.work_date = p_date
      AND NOT EXISTS (SELECT 1 FROM public.shifts s WHERE s.employee_id = t.employee_id AND s.work_date = p_date AND s.state = 'PUBLISHED' AND NOT s.is_off)
    ORDER BY 1
  ), grace AS (SELECT late_grace_minutes AS g FROM public.organizations WHERE id = private.current_org_id())
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'employee_id', p.employee_id, 'name', e.full_name, 'position', e.position, 'branch_id', p.branch_id,
      'off', p.is_off, 'leave', p.leave_type, 'start', p.start_time, 'end', p.end_time, 'note', p.note,
      'time_in', i.punched_at, 'time_out', o.punched_at, 'in_photo', i.photo_path, 'in_distance_m', i.distance_m,
      'late_min', CASE WHEN p.start_time IS NOT NULL AND i.punched_at IS NOT NULL
                       THEN greatest(0, floor(extract(epoch FROM ((i.punched_at AT TIME ZONE 'Asia/Manila') - (p_date + p.start_time))) / 60)::int
                                       - (SELECT g FROM grace)) END)
    ORDER BY p.is_off, e.full_name), '[]'::jsonb)
  FROM people p JOIN public.employees e ON e.id = p.employee_id
  LEFT JOIN LATERAL (SELECT t.punched_at, t.photo_path, t.distance_m FROM public.time_punches t WHERE t.employee_id = p.employee_id AND t.work_date = p_date AND t.kind = 'IN' ORDER BY t.punched_at LIMIT 1) i ON true
  LEFT JOIN LATERAL (SELECT t.punched_at FROM public.time_punches t WHERE t.employee_id = p.employee_id AND t.work_date = p_date AND t.kind = 'OUT' ORDER BY t.punched_at DESC LIMIT 1) o ON true
  WHERE private.can_schedule(p.employee_id)
$$;

CREATE OR REPLACE FUNCTION public.week_schedule(p_monday date) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH me AS (SELECT private.my_employee_id() AS id),
  mine AS (SELECT DISTINCT s.branch_id FROM public.shifts s, me
           WHERE s.employee_id = me.id AND s.work_date BETWEEN p_monday AND p_monday + 6 AND s.state = 'PUBLISHED' AND s.branch_id IS NOT NULL
           UNION SELECT e.branch_id FROM public.employees e, me WHERE e.id = me.id),
  wk AS (
    SELECT s.* FROM public.shifts s, me
    WHERE s.organization_id = private.current_org_id() AND s.work_date BETWEEN p_monday AND p_monday + 6
      AND (private.can_schedule(s.employee_id)
           OR (s.state = 'PUBLISHED' AND (s.employee_id = me.id
               OR EXISTS (SELECT 1 FROM public.shifts x WHERE x.employee_id = s.employee_id AND x.work_date BETWEEN p_monday AND p_monday + 6
                          AND x.state = 'PUBLISHED' AND x.branch_id IN (SELECT branch_id FROM mine)))))
  ), ppl AS (
    SELECT e.id, e.full_name, e.position, e.branch_id, private.can_schedule(e.id) AS can_edit FROM public.employees e
    WHERE e.organization_id = private.current_org_id() AND e.active
      AND (private.can_schedule(e.id) OR e.id IN (SELECT employee_id FROM wk) OR e.id = (SELECT id FROM me))
  )
  SELECT jsonb_build_object(
    'me', (SELECT id FROM me),
    'people', coalesce((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'name', p.full_name, 'position', p.position, 'branch_id', p.branch_id,
        'can_edit', p.can_edit,
        'pattern', CASE WHEN p.can_edit THEN (SELECT jsonb_build_object('branch_id', sp.branch_id, 'days_off', sp.days_off,
                         'start', to_char(sp.start_time, 'HH24:MI'), 'end', to_char(sp.end_time, 'HH24:MI'))
                         FROM public.schedule_patterns sp WHERE sp.employee_id = p.id) END)
        ORDER BY p.full_name) FROM ppl p), '[]'::jsonb),
    'shifts', coalesce((SELECT jsonb_agg(jsonb_build_object('employee_id', w.employee_id, 'date', w.work_date, 'off', w.is_off,
        'branch_id', w.branch_id, 'start', to_char(w.start_time, 'HH24:MI'), 'end', to_char(w.end_time, 'HH24:MI'),
        'state', w.state, 'note', w.note, 'leave', w.leave_type)) FROM wk w), '[]'::jsonb),
    'requests', coalesce((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'kind', r.kind, 'employee_id', r.employee_id, 'name', e.full_name,
        'date', r.work_date, 'other_employee_id', r.other_employee_id, 'other_name', o.full_name, 'other_date', r.other_date,
        'reason', r.reason, 'mine', r.requested_by = private.current_user_id(), 'can_decide', private.can_schedule(r.employee_id)
          AND r.requested_by <> private.current_user_id(), 'created_at', r.created_at) ORDER BY r.created_at)
        FROM public.schedule_requests r JOIN public.employees e ON e.id = r.employee_id
        LEFT JOIN public.employees o ON o.id = r.other_employee_id, me
        WHERE r.organization_id = private.current_org_id() AND r.state = 'PENDING'
          AND (r.requested_by = private.current_user_id() OR r.other_employee_id = me.id OR private.can_schedule(r.employee_id))), '[]'::jsonb))
$$;

REVOKE ALL ON FUNCTION public.save_day(date, jsonb), public.copy_last_week(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_day(date, jsonb), public.copy_last_week(date) TO authenticated;
