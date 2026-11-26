-- update-0067 (CHRIS Nov 26): management reviews each explained Late NTE.
--   * Accept reason: the NTE no longer counts toward an IR (state ACCEPTED).
--   * Reject reason: it keeps counting (state stays EXPLAINED, marked REJECTED).
-- The employee is told either way. A decision can be changed until the NTE is in an IR.
ALTER TABLE public.late_ntes DROP CONSTRAINT IF EXISTS late_ntes_state_check;
ALTER TABLE public.late_ntes ADD CONSTRAINT late_ntes_state_check CHECK (state IN ('OPEN','EXPLAINED','ACCEPTED','VOID'));
ALTER TABLE public.late_ntes ADD COLUMN IF NOT EXISTS review text CHECK (review IS NULL OR review IN ('ACCEPTED','REJECTED'));
ALTER TABLE public.late_ntes ADD COLUMN IF NOT EXISTS review_note text CHECK (review_note IS NULL OR length(review_note) <= 500);
ALTER TABLE public.late_ntes ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES public.app_users(id);
ALTER TABLE public.late_ntes ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;

CREATE OR REPLACE FUNCTION public.review_nte(p_id uuid, p_accept boolean, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE n public.late_ntes%ROWTYPE; v_note text := nullif(left(btrim(coalesce(p_note, '')), 500), '');
BEGIN
  IF private.current_user_id() IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  SELECT * INTO n FROM public.late_ntes WHERE id = p_id AND organization_id = private.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF NOT private.can_schedule(n.employee_id) OR n.employee_id = private.my_employee_id() THEN RETURN private.deny(n.branch_id, 'late_nte'); END IF;
  IF n.state NOT IN ('EXPLAINED','ACCEPTED') OR n.ir_id IS NOT NULL OR p_accept IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_PENDING'); END IF;
  UPDATE public.late_ntes SET state = CASE WHEN p_accept THEN 'ACCEPTED' ELSE 'EXPLAINED' END,
    review = CASE WHEN p_accept THEN 'ACCEPTED' ELSE 'REJECTED' END, review_note = v_note,
    reviewed_by = private.current_user_id(), reviewed_at = now()
  WHERE id = p_id;
  PERFORM private.notify_employee(n.employee_id, 'NTE_REVIEWED',
    CASE WHEN p_accept THEN 'Late NTE: reason accepted' ELSE 'Late NTE: reason not accepted' END,
    'NTE no. ' || n.nte_no || ' (' || to_char(n.work_date, 'Mon FMDD') || '): ' ||
    CASE WHEN p_accept THEN 'your reason was accepted, so it does not count toward an IR.' ELSE 'your reason was not accepted, so it counts toward an IR.' END ||
    coalesce(' Note: ' || v_note, ''), '/nte');
  PERFORM private.audit(n.branch_id, CASE WHEN p_accept THEN 'NTE_ACCEPTED' ELSE 'NTE_REJECTED' END, 'late_nte', p_id::text, NULL,
    jsonb_build_object('note', v_note));
  RETURN jsonb_build_object('ok', true, 'state', CASE WHEN p_accept THEN 'ACCEPTED' ELSE 'EXPLAINED' END);
END $$;
REVOKE ALL ON FUNCTION public.review_nte(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_nte(uuid, boolean, text) TO authenticated;

-- Accepted NTEs never go into an IR.
CREATE OR REPLACE FUNCTION public.issue_late_ir(p_employee uuid, p_month date, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_org uuid := private.current_org_id(); v_s date; v_e date; v_days jsonb; v_n integer; v_min integer; v_branch uuid; v_id uuid;
BEGIN
  IF private.current_user_id() IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT private.can_schedule(p_employee) OR p_employee = private.my_employee_id() THEN RETURN private.deny(NULL, 'incident_report'); END IF;
  v_s := date_trunc('month', coalesce(p_month, (now() AT TIME ZONE 'Asia/Manila')::date))::date;
  v_e := (v_s + interval '1 month - 1 day')::date;
  PERFORM 1 FROM public.late_ntes WHERE employee_id = p_employee AND work_date BETWEEN v_s AND v_e FOR UPDATE;
  SELECT count(*), coalesce(sum(n.late_minutes), 0),
         coalesce(jsonb_agg(jsonb_build_object('date', n.work_date, 'branch', b.name, 'start', to_char(n.shift_start, 'HH24:MI'),
           'time_in', to_char(n.time_in AT TIME ZONE 'Asia/Manila', 'HH24:MI'), 'late_min', n.late_minutes, 'nte_no', n.nte_no,
           'explanation', n.explanation) ORDER BY n.work_date), '[]'::jsonb)
  INTO v_n, v_min, v_days
  FROM public.late_ntes n LEFT JOIN public.branches b ON b.id = n.branch_id
  WHERE n.employee_id = p_employee AND n.work_date BETWEEN v_s AND v_e AND n.state NOT IN ('VOID','ACCEPTED') AND n.ir_id IS NULL;
  IF v_n = 0 THEN RETURN jsonb_build_object('ok', false, 'error', 'NOTHING_TO_ISSUE'); END IF;
  SELECT branch_id INTO v_branch FROM public.employees WHERE id = p_employee;
  PERFORM pg_advisory_xact_lock(hashtext('ir_no:' || v_org::text));
  INSERT INTO public.incident_reports (organization_id, ir_no, employee_id, branch_id, period_start, period_end, late_minutes, late_days,
    limit_minutes, details, state, basis, issue_note, issued_by, issued_at)
  VALUES (v_org, coalesce((SELECT max(ir_no) FROM public.incident_reports WHERE organization_id = v_org), 0) + 1, p_employee, v_branch,
    v_s, v_e, v_min, v_n, 0, v_days, 'ISSUED', 'LATE_NTE', nullif(left(btrim(coalesce(p_note, '')), 1000), ''), private.current_user_id(), now())
  RETURNING id INTO v_id;
  UPDATE public.late_ntes SET ir_id = v_id
  WHERE employee_id = p_employee AND work_date BETWEEN v_s AND v_e AND state NOT IN ('VOID','ACCEPTED') AND ir_id IS NULL;
  PERFORM private.notify_employee(p_employee, 'IR_ISSUED', 'URGENT: Incident report issued',
    'An IR for ' || v_n || ' late arrival' || CASE WHEN v_n = 1 THEN '' ELSE 's' END || ' in ' || to_char(v_s, 'FMMonth YYYY') ||
    ' was issued to you. Please acknowledge it and write your response.', '/incidents/' || v_id);
  PERFORM private.audit(v_branch, 'IR_ISSUED', 'incident_report', v_id::text, NULL, jsonb_build_object('basis', 'LATE_NTE', 'ntes', v_n));
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END $$;

-- The list carries the review.
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
      'proof_paths', proof_paths, 'review', review, 'review_note', review_note, 'reviewed_at', reviewed_at,
      'ir_id', ir_id, 'mine', mine, 'can_manage', can_manage) ORDER BY work_date DESC, nte_no DESC) FROM n), '[]'::jsonb))
$$;
