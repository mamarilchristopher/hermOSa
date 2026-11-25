-- update-0044: irregular days (Hermosa OS v0.44.0). CHRIS: management (owners and the GM) can tag a day as irregular
-- (maintenance, emergency, or another reason typed in) so lateness that day is ignored: no late minutes, no Late NTE,
-- and it doesn't count toward IRs. One person's day, or the whole company's day.

CREATE TABLE IF NOT EXISTS public.irregular_days (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  work_date date NOT NULL,
  employee_id uuid REFERENCES public.employees(id),   -- NULL = everyone that day
  reason text NOT NULL CHECK (reason IN ('MAINTENANCE','EMERGENCY','OTHER')),
  note text CHECK (note IS NULL OR length(note) <= 300),
  created_by uuid NOT NULL REFERENCES public.app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (reason <> 'OTHER' OR length(btrim(coalesce(note, ''))) >= 3)
);
CREATE UNIQUE INDEX IF NOT EXISTS irregular_days_one ON public.irregular_days (organization_id, work_date, coalesce(employee_id, '00000000-0000-0000-0000-000000000000'::uuid));
ALTER TABLE public.irregular_days ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.irregular_days TO authenticated;
DROP POLICY IF EXISTS irregular_days_read ON public.irregular_days;
CREATE POLICY irregular_days_read ON public.irregular_days FOR SELECT TO authenticated USING (organization_id = private.current_org_id());

CREATE OR REPLACE FUNCTION private.is_irregular(p_employee uuid, p_date date) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.irregular_days x JOIN public.employees e ON e.organization_id = x.organization_id
                 WHERE e.id = p_employee AND x.work_date = p_date AND (x.employee_id IS NULL OR x.employee_id = p_employee))
$$;
REVOKE ALL ON FUNCTION private.is_irregular(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.is_irregular(uuid, date) TO authenticated;

-- Tag a day (p_employee NULL = everyone). Owners and the GM. Open Late NTEs for it are voided (ones already turned into an IR stay).
CREATE OR REPLACE FUNCTION public.set_irregular_day(p_date date, p_employee uuid, p_reason text, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_org uuid := private.current_org_id(); v_user uuid := private.current_user_id(); v_reason text := upper(coalesce(p_reason, ''));
        v_note text := nullif(left(btrim(coalesce(p_note, '')), 300), ''); v_id uuid; v_voided integer; v_kept integer; v_text text;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT (private.has_role(ARRAY['OWNER'], NULL) OR private.is_gm()) THEN RETURN private.deny(NULL, 'irregular_day'); END IF;
  IF p_date IS NULL OR p_date > (now() AT TIME ZONE 'Asia/Manila')::date + 31 THEN RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST'); END IF;
  IF v_reason NOT IN ('MAINTENANCE','EMERGENCY','OTHER') THEN RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST'); END IF;
  IF v_reason = 'OTHER' AND length(coalesce(v_note, '')) < 3 THEN RETURN jsonb_build_object('ok', false, 'error', 'OTHER_REASON_REQUIRED'); END IF;
  IF p_employee IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.employees WHERE id = p_employee AND organization_id = v_org) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND');
  END IF;
  INSERT INTO public.irregular_days (organization_id, work_date, employee_id, reason, note, created_by)
  VALUES (v_org, p_date, p_employee, v_reason, v_note, v_user)
  ON CONFLICT (organization_id, work_date, coalesce(employee_id, '00000000-0000-0000-0000-000000000000'::uuid))
  DO UPDATE SET reason = EXCLUDED.reason, note = EXCLUDED.note, created_by = EXCLUDED.created_by, created_at = now()
  RETURNING id INTO v_id;
  v_text := 'Irregular day: ' || CASE v_reason WHEN 'MAINTENANCE' THEN 'maintenance' WHEN 'EMERGENCY' THEN 'emergency' ELSE 'other' END || coalesce(' (' || v_note || ')', '');
  UPDATE public.late_ntes SET state = 'VOID', void_reason = left(v_text, 500), voided_by = v_user, voided_at = now()
  WHERE organization_id = v_org AND work_date = p_date AND state <> 'VOID' AND ir_id IS NULL
    AND (p_employee IS NULL OR employee_id = p_employee);
  GET DIAGNOSTICS v_voided = ROW_COUNT;
  SELECT count(*) INTO v_kept FROM public.late_ntes WHERE organization_id = v_org AND work_date = p_date AND state <> 'VOID' AND ir_id IS NOT NULL
    AND (p_employee IS NULL OR employee_id = p_employee);
  PERFORM private.audit(NULL, 'IRREGULAR_DAY', 'irregular_day', v_id::text, NULL,
    jsonb_build_object('date', p_date, 'employee', p_employee, 'reason', v_reason, 'note', v_note, 'ntes_voided', v_voided));
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'ntes_voided', v_voided, 'ntes_with_ir', v_kept);
END $$;

-- Untag. Late NTEs voided by the tag stay void.
CREATE OR REPLACE FUNCTION public.clear_irregular_day(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE x public.irregular_days%ROWTYPE;
BEGIN
  IF private.current_user_id() IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT (private.has_role(ARRAY['OWNER'], NULL) OR private.is_gm()) THEN RETURN private.deny(NULL, 'irregular_day'); END IF;
  DELETE FROM public.irregular_days WHERE id = p_id AND organization_id = private.current_org_id() RETURNING * INTO x;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  PERFORM private.audit(NULL, 'IRREGULAR_DAY_CLEARED', 'irregular_day', p_id::text, to_jsonb(x), NULL);
  RETURN jsonb_build_object('ok', true);
END $$;
REVOKE ALL ON FUNCTION public.set_irregular_day(date, uuid, text, text), public.clear_irregular_day(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_irregular_day(date, uuid, text, text), public.clear_irregular_day(uuid) TO authenticated;

-- No Late NTE on an irregular day (from update-0032).
CREATE OR REPLACE FUNCTION private.make_late_nte(p_punch uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE t public.time_punches%ROWTYPE; s public.shifts%ROWTYPE; v_grace integer; v_late integer; v_id uuid; v_name text; v_by date;
BEGIN
  SELECT * INTO t FROM public.time_punches WHERE id = p_punch;
  IF NOT FOUND OR t.kind <> 'IN' THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM public.time_punches x WHERE x.employee_id = t.employee_id AND x.work_date = t.work_date AND x.kind = 'IN'
             AND x.punched_at < t.punched_at) THEN RETURN NULL; END IF;
  SELECT * INTO s FROM public.shifts WHERE employee_id = t.employee_id AND work_date = t.work_date AND state = 'PUBLISHED' AND NOT is_off LIMIT 1;
  IF NOT FOUND OR s.start_time IS NULL THEN RETURN NULL; END IF;
  IF private.is_irregular(t.employee_id, t.work_date) THEN RETURN NULL; END IF;  -- update-0044
  SELECT late_grace_minutes INTO v_grace FROM public.organizations WHERE id = t.organization_id;
  v_late := floor(extract(epoch FROM ((t.punched_at AT TIME ZONE 'Asia/Manila') - (t.work_date + s.start_time))) / 60)::int;
  IF v_late <= coalesce(v_grace, 0) THEN RETURN NULL; END IF;
  v_by := private.nte_respond_by(t.employee_id, t.work_date);
  PERFORM pg_advisory_xact_lock(hashtext('nte_no:' || t.organization_id::text));
  INSERT INTO public.late_ntes (organization_id, nte_no, employee_id, branch_id, work_date, shift_start, time_in, late_minutes, grace_minutes, punch_id, respond_by)
  VALUES (t.organization_id, coalesce((SELECT max(nte_no) FROM public.late_ntes WHERE organization_id = t.organization_id), 0) + 1,
          t.employee_id, coalesce(s.branch_id, t.branch_id), t.work_date, s.start_time, t.punched_at, v_late, coalesce(v_grace, 0), t.id, v_by)
  ON CONFLICT (employee_id, work_date) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN
    INSERT INTO public.notifications (organization_id, user_id, kind, title, body, link, created_by)
    SELECT e.organization_id, e.app_user_id, 'NTE_LATE', 'Late NTE: please explain',
      'You timed in ' || v_late || ' minutes after your ' || to_char(s.start_time, 'FMHH12:MI AM') || ' start. Explain by the end of ' || coalesce(to_char(v_by, 'Dy, Mon FMDD'), 'your next working day') || ', or an IR is issued automatically.', '/nte', NULL
    FROM public.employees e WHERE e.id = t.employee_id AND e.app_user_id IS NOT NULL;
  END IF;
  RETURN v_id;
END $$;

-- Cutoff tardiness ignores irregular days (from update-0023).
CREATE OR REPLACE FUNCTION private.late_days(p_employee uuid, p_start date, p_end date) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH g AS (SELECT o.late_grace_minutes AS g FROM public.employees e JOIN public.organizations o ON o.id = e.organization_id WHERE e.id = p_employee),
  d AS (
    SELECT s.work_date, s.start_time, b.name AS branch, i.punched_at,
           greatest(0, floor(extract(epoch FROM ((i.punched_at AT TIME ZONE 'Asia/Manila') - (s.work_date + s.start_time))) / 60)::int - (SELECT g FROM g)) AS late
    FROM public.shifts s
    JOIN LATERAL (SELECT t.punched_at FROM public.time_punches t WHERE t.employee_id = s.employee_id AND t.work_date = s.work_date AND t.kind = 'IN'
                  ORDER BY t.punched_at LIMIT 1) i ON true
    LEFT JOIN public.branches b ON b.id = s.branch_id
    WHERE s.employee_id = p_employee AND s.state = 'PUBLISHED' AND NOT s.is_off AND s.work_date BETWEEN p_start AND p_end
      AND NOT private.is_irregular(s.employee_id, s.work_date)
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('date', work_date, 'branch', branch, 'start', to_char(start_time, 'HH24:MI'),
           'time_in', to_char(punched_at AT TIME ZONE 'Asia/Manila', 'HH24:MI'), 'late_min', late) ORDER BY work_date), '[]'::jsonb)
  FROM d WHERE late > 0
$$;

-- On Duty shows the tag and no late minutes (from update-0029).
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
      'employee_id', p.employee_id, 'name', e.full_name, 'uid', e.uid, 'position', e.position, 'branch_id', p.branch_id,
      'off', p.is_off, 'leave', p.leave_type, 'start', p.start_time, 'end', p.end_time, 'note', p.note,
      'time_in', i.punched_at, 'time_out', o.punched_at, 'in_photo', i.photo_path, 'in_distance_m', i.distance_m,
      'irregular', (SELECT jsonb_build_object('id', x.id, 'reason', x.reason, 'note', x.note, 'whole_day', x.employee_id IS NULL)
                    FROM public.irregular_days x WHERE x.organization_id = private.current_org_id() AND x.work_date = p_date
                      AND (x.employee_id = p.employee_id OR x.employee_id IS NULL) ORDER BY x.employee_id NULLS LAST LIMIT 1),
      'late_min', CASE WHEN p.start_time IS NOT NULL AND i.punched_at IS NOT NULL AND NOT private.is_irregular(p.employee_id, p_date)
                       THEN greatest(0, floor(extract(epoch FROM ((i.punched_at AT TIME ZONE 'Asia/Manila') - (p_date + p.start_time))) / 60)::int
                                       - (SELECT g FROM grace)) END)
    ORDER BY p.is_off, e.full_name), '[]'::jsonb)
  FROM people p JOIN public.employees e ON e.id = p.employee_id
  LEFT JOIN LATERAL (SELECT t.punched_at, t.photo_path, t.distance_m FROM public.time_punches t WHERE t.employee_id = p.employee_id AND t.work_date = p_date AND t.kind = 'IN' ORDER BY t.punched_at LIMIT 1) i ON true
  LEFT JOIN LATERAL (SELECT t.punched_at FROM public.time_punches t WHERE t.employee_id = p.employee_id AND t.work_date = p_date AND t.kind = 'OUT' ORDER BY t.punched_at DESC LIMIT 1) o ON true
  WHERE private.can_schedule(p.employee_id)
$$;

-- Attendance: irregular days don't count as late (from update-0029).
CREATE OR REPLACE FUNCTION public.attendance(p_start date, p_end date) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(jsonb_agg(x ORDER BY x ->> 'name'), '[]'::jsonb) FROM (
    SELECT jsonb_build_object('employee_id', e.id, 'name', e.full_name, 'uid', e.uid,
      'scheduled', count(*) FILTER (WHERE NOT s.is_off),
      'present', count(i.punched_at) FILTER (WHERE NOT s.is_off),
      'absent', count(*) FILTER (WHERE NOT s.is_off AND i.punched_at IS NULL AND s.work_date < (now() AT TIME ZONE 'Asia/Manila')::date),
      'late_days', count(*) FILTER (WHERE NOT s.is_off AND NOT private.is_irregular(s.employee_id, s.work_date) AND (i.punched_at AT TIME ZONE 'Asia/Manila') > s.work_date + s.start_time
                                       + make_interval(mins => (SELECT late_grace_minutes FROM public.organizations WHERE id = private.current_org_id()))),
      'late_min', coalesce(sum(greatest(0, floor(extract(epoch FROM ((i.punched_at AT TIME ZONE 'Asia/Manila') - (s.work_date + s.start_time))) / 60)::int
                       - (SELECT late_grace_minutes FROM public.organizations WHERE id = private.current_org_id()))) FILTER (WHERE NOT s.is_off AND NOT private.is_irregular(s.employee_id, s.work_date)), 0)) AS x
    FROM public.shifts s JOIN public.employees e ON e.id = s.employee_id
    LEFT JOIN LATERAL (SELECT t.punched_at FROM public.time_punches t WHERE t.employee_id = s.employee_id AND t.work_date = s.work_date AND t.kind = 'IN'
                       ORDER BY t.punched_at LIMIT 1) i ON true
    WHERE s.organization_id = private.current_org_id() AND s.state = 'PUBLISHED' AND s.work_date BETWEEN p_start AND p_end
      AND p_end - p_start <= 62 AND private.can_schedule(s.employee_id)
    GROUP BY e.id, e.full_name, e.uid) y
$$;
