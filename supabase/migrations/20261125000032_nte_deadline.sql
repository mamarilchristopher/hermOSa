-- update-0032: Late NTE response deadline and automatic IR (CHRIS, Nov 25 2026). Needs update-0030. Safe to run more than once.
-- * The employee has 2 scheduled working days to explain, counting the day they were late: the deadline is the end of
--   their next scheduled working day after the late day (published schedule, days off and leave don't count).
-- * No explanation by then (or one written after the deadline) issues an IR automatically for that NTE,
--   urgent on the employee's Home, and management is told. Checked at every time-in and whenever someone opens Home or Late NTEs.

ALTER TABLE public.late_ntes ADD COLUMN IF NOT EXISTS respond_by date;

-- The last day to explain: the employee's next scheduled working day after the late day (NULL until that day is published).
CREATE OR REPLACE FUNCTION private.nte_respond_by(p_employee uuid, p_work_date date) RETURNS date
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT s.work_date FROM public.shifts s
  WHERE s.employee_id = p_employee AND s.work_date > p_work_date AND s.state = 'PUBLISHED' AND NOT s.is_off
  ORDER BY s.work_date LIMIT 1
$$;

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

-- Fill in deadlines and issue the automatic IRs that are due. Returns how many IRs were issued.
CREATE OR REPLACE FUNCTION private.escalate_ntes(p_org uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_today date := (now() AT TIME ZONE 'Asia/Manila')::date; n record; v_id uuid; v_count integer := 0; v_branch uuid; v_s date;
BEGIN
  IF p_org IS NULL THEN RETURN 0; END IF;
  UPDATE public.late_ntes x SET respond_by = private.nte_respond_by(x.employee_id, x.work_date)
  WHERE x.organization_id = p_org AND x.ir_id IS NULL AND x.state <> 'VOID' AND (x.respond_by IS NULL OR x.respond_by >= v_today)
    AND x.respond_by IS DISTINCT FROM private.nte_respond_by(x.employee_id, x.work_date);
  FOR n IN
    SELECT x.*, b.name AS branch_name FROM public.late_ntes x LEFT JOIN public.branches b ON b.id = x.branch_id
    WHERE x.organization_id = p_org AND x.ir_id IS NULL AND x.respond_by IS NOT NULL AND x.respond_by < v_today
      AND (x.state = 'OPEN' OR (x.state = 'EXPLAINED' AND (x.explained_at AT TIME ZONE 'Asia/Manila')::date > x.respond_by))
    ORDER BY x.work_date
    FOR UPDATE OF x SKIP LOCKED
  LOOP
    SELECT branch_id INTO v_branch FROM public.employees WHERE id = n.employee_id;
    v_s := date_trunc('month', n.work_date)::date;
    PERFORM pg_advisory_xact_lock(hashtext('ir_no:' || p_org::text));
    INSERT INTO public.incident_reports (organization_id, ir_no, employee_id, branch_id, period_start, period_end, late_minutes, late_days,
      limit_minutes, details, state, basis, issue_note, issued_by, issued_at)
    VALUES (p_org, coalesce((SELECT max(ir_no) FROM public.incident_reports WHERE organization_id = p_org), 0) + 1, n.employee_id, v_branch,
      v_s, (v_s + interval '1 month - 1 day')::date, n.late_minutes, 1, 0,
      jsonb_build_array(jsonb_build_object('date', n.work_date, 'branch', n.branch_name, 'start', to_char(n.shift_start, 'HH24:MI'),
        'time_in', to_char(n.time_in AT TIME ZONE 'Asia/Manila', 'HH24:MI'), 'late_min', n.late_minutes, 'nte_no', n.nte_no, 'explanation', n.explanation)),
      'ISSUED', 'LATE_NTE',
      'Issued automatically: Late NTE no. ' || n.nte_no || ' was not explained by the end of ' || to_char(n.respond_by, 'Mon FMDD, YYYY')
        || ' (2 scheduled working days, counting the day of the late arrival).',
      NULL, now())
    RETURNING id INTO v_id;
    UPDATE public.late_ntes SET ir_id = v_id WHERE id = n.id;
    PERFORM private.notify_employee(n.employee_id, 'IR_ISSUED', 'URGENT: Incident report issued',
      'Your Late NTE for ' || to_char(n.work_date, 'Mon FMDD') || ' was not explained within 2 working days, so an IR was issued. Please acknowledge it and write your response.',
      '/incidents/' || v_id);
    INSERT INTO public.notifications (organization_id, user_id, kind, title, body, link, created_by)
    SELECT DISTINCT p_org, g.user_id, 'IR_AUTO', 'IR issued automatically',
      left(coalesce((SELECT full_name FROM public.employees WHERE id = n.employee_id), 'Someone') || ' did not explain Late NTE no. ' || n.nte_no
        || ' (' || to_char(n.work_date, 'Mon FMDD') || ') within 2 working days. IR issued automatically.', 1000), '/incidents/' || v_id, NULL::uuid
    FROM public.role_grants g JOIN public.app_users u ON u.id = g.user_id AND u.active
    WHERE g.revoked_at IS NULL AND u.organization_id = p_org AND (g.role_code = 'OWNER' OR (g.role_code = 'MANAGER' AND (g.branch_id IS NULL OR g.branch_id = v_branch)))
      AND NOT EXISTS (SELECT 1 FROM public.employees e WHERE e.id = n.employee_id AND e.app_user_id = g.user_id);
    PERFORM private.audit(v_branch, 'IR_ISSUED', 'incident_report', v_id::text, NULL, jsonb_build_object('basis', 'LATE_NTE', 'automatic', true, 'nte', n.nte_no));
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $$;

-- Any signed-in person's app runs this when Home or Late NTEs opens; it only acts on what's overdue.
CREATE OR REPLACE FUNCTION public.run_nte_deadlines() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF private.current_user_id() IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  RETURN jsonb_build_object('ok', true, 'issued', private.escalate_ntes(private.current_org_id()));
END $$;

-- Every time-in also checks deadlines, so overdue NTEs become IRs every working day even if nobody opens Home.
CREATE OR REPLACE FUNCTION private.time_punch_tardiness() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.kind = 'IN' THEN
    PERFORM private.make_late_nte(NEW.id);
    PERFORM private.escalate_ntes(NEW.organization_id);
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.late_nte_list(p_month date, p_employee uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH m AS (SELECT date_trunc('month', coalesce(p_month, (now() AT TIME ZONE 'Asia/Manila')::date))::date AS s),
  n AS (
    SELECT x.*, e.full_name, e.uid, e.position, b.name AS branch,
           x.employee_id = private.my_employee_id() AS mine,
           private.can_schedule(x.employee_id) AND x.employee_id IS DISTINCT FROM private.my_employee_id() AS can_manage
    FROM public.late_ntes x JOIN public.employees e ON e.id = x.employee_id LEFT JOIN public.branches b ON b.id = x.branch_id, m
    WHERE x.organization_id = private.current_org_id()
      AND x.work_date >= m.s AND x.work_date < (m.s + interval '1 month')::date
      AND (p_employee IS NULL OR x.employee_id = p_employee)
      AND (private.can_schedule(x.employee_id) OR x.employee_id = private.my_employee_id())
  )
  SELECT jsonb_build_object('month', (SELECT s FROM m),
    'grace', (SELECT late_grace_minutes FROM public.organizations WHERE id = private.current_org_id()),
    'ir_minutes', (SELECT ir_late_minutes FROM public.organizations WHERE id = private.current_org_id()),
    'ntes', coalesce((SELECT jsonb_agg(jsonb_build_object('id', id, 'nte_no', nte_no, 'employee_id', employee_id, 'name', full_name, 'uid', uid, 'position', position,
      'branch', branch, 'work_date', work_date, 'shift_start', to_char(shift_start, 'HH24:MI'), 'time_in', to_char(time_in AT TIME ZONE 'Asia/Manila', 'HH24:MI'),
      'late_minutes', late_minutes, 'respond_by', respond_by, 'state', state, 'explanation', explanation, 'explained_at', explained_at, 'void_reason', void_reason,
      'ir_id', ir_id, 'mine', mine, 'can_manage', can_manage) ORDER BY work_date DESC, nte_no DESC) FROM n), '[]'::jsonb))
$$;

-- NTEs made before this update get their deadline now.
UPDATE public.late_ntes x SET respond_by = private.nte_respond_by(x.employee_id, x.work_date) WHERE x.respond_by IS NULL AND x.state <> 'VOID';

REVOKE ALL ON FUNCTION private.nte_respond_by(uuid, date), private.escalate_ntes(uuid), public.run_nte_deadlines() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.run_nte_deadlines() TO authenticated;
