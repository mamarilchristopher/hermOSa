-- HERMOSA OS 0023: tardiness incident reports (IR), made automatically (owner request 2026-11-25).
-- Safe to run more than once.
-- * When someone's total late minutes in a payroll cutoff (1st-15th, 16th-end) reach the limit, the app drafts
--   an IR with the late days (from the published schedule and time-ins) and tells management.
--   The draft keeps updating while more late days come in, until a manager issues it.
-- * A manager or owner reviews and issues it; the employee writes their explanation; a manager closes it with
--   the action taken. The limit (minutes per cutoff, default 60) is set by an owner.

ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS ir_late_minutes integer NOT NULL DEFAULT 60
  CHECK (ir_late_minutes BETWEEN 1 AND 1440);

CREATE TABLE IF NOT EXISTS public.incident_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  ir_no integer NOT NULL,
  employee_id uuid NOT NULL REFERENCES public.employees(id),
  branch_id uuid REFERENCES public.branches(id),
  kind text NOT NULL DEFAULT 'TARDINESS' CHECK (kind IN ('TARDINESS')),
  period_start date NOT NULL,
  period_end date NOT NULL,
  late_minutes integer NOT NULL,
  late_days integer NOT NULL,
  limit_minutes integer NOT NULL,
  details jsonb NOT NULL DEFAULT '[]'::jsonb,         -- [{date, branch, start, time_in, late_min}]
  state text NOT NULL DEFAULT 'DRAFT' CHECK (state IN ('DRAFT','ISSUED','EXPLAINED','CLOSED','DISMISSED')),
  issue_note text CHECK (issue_note IS NULL OR length(issue_note) <= 1000),
  issued_by uuid REFERENCES public.app_users(id), issued_at timestamptz,
  explanation text CHECK (explanation IS NULL OR length(explanation) <= 2000),
  explained_at timestamptz,
  action_taken text CHECK (action_taken IS NULL OR length(action_taken) <= 1000),
  closed_by uuid REFERENCES public.app_users(id), closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, kind, period_start),
  UNIQUE (organization_id, ir_no)
);
ALTER TABLE public.incident_reports ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.incident_reports TO authenticated;
-- Management sees their people's IRs; the employee sees their own once it's issued (never the draft).
DROP POLICY IF EXISTS incident_reports_read ON public.incident_reports;
CREATE POLICY incident_reports_read ON public.incident_reports FOR SELECT TO authenticated
  USING (organization_id = private.current_org_id()
         AND (private.can_schedule(employee_id) OR (employee_id = private.my_employee_id() AND state <> 'DRAFT')));

-- Payroll cutoff that holds a date.
CREATE OR REPLACE FUNCTION private.cutoff_of(p_date date, OUT c_start date, OUT c_end date)
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN extract(day FROM p_date) <= 15 THEN date_trunc('month', p_date)::date ELSE date_trunc('month', p_date)::date + 15 END,
         CASE WHEN extract(day FROM p_date) <= 15 THEN date_trunc('month', p_date)::date + 14
              ELSE (date_trunc('month', p_date) + interval '1 month - 1 day')::date END
$$;

-- Late days for one person in a period: published working days with a first time-in after start + grace.
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
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('date', work_date, 'branch', branch, 'start', to_char(start_time, 'HH24:MI'),
           'time_in', to_char(punched_at AT TIME ZONE 'Asia/Manila', 'HH24:MI'), 'late_min', late) ORDER BY work_date), '[]'::jsonb)
  FROM d WHERE late > 0
$$;

-- Make or refresh the IR draft for one person's cutoff. Issued / closed IRs are never changed.
CREATE OR REPLACE FUNCTION private.check_tardiness(p_employee uuid, p_date date) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c record; v_days jsonb; v_total integer; v_limit integer; v_org uuid; v_branch uuid; v_name text; v_new boolean := false; v_id uuid;
BEGIN
  SELECT * INTO c FROM private.cutoff_of(p_date);
  SELECT e.organization_id, e.branch_id, e.full_name, o.ir_late_minutes INTO v_org, v_branch, v_name, v_limit
    FROM public.employees e JOIN public.organizations o ON o.id = e.organization_id WHERE e.id = p_employee;
  IF v_org IS NULL THEN RETURN; END IF;
  v_days := private.late_days(p_employee, c.c_start, c.c_end);
  v_total := coalesce((SELECT sum((x ->> 'late_min')::int) FROM jsonb_array_elements(v_days) x), 0);
  IF EXISTS (SELECT 1 FROM public.incident_reports WHERE employee_id = p_employee AND kind = 'TARDINESS' AND period_start = c.c_start) THEN
    UPDATE public.incident_reports SET late_minutes = v_total, late_days = jsonb_array_length(v_days), details = v_days, updated_at = now()
    WHERE employee_id = p_employee AND kind = 'TARDINESS' AND period_start = c.c_start AND state = 'DRAFT';
    RETURN;
  END IF;
  IF v_total < v_limit THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('ir_no:' || v_org::text));
  INSERT INTO public.incident_reports (organization_id, ir_no, employee_id, branch_id, period_start, period_end, late_minutes, late_days, limit_minutes, details)
  VALUES (v_org, coalesce((SELECT max(ir_no) FROM public.incident_reports WHERE organization_id = v_org), 0) + 1, p_employee, v_branch,
          c.c_start, c.c_end, v_total, jsonb_array_length(v_days), v_limit, v_days)
  ON CONFLICT (employee_id, kind, period_start) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN
    -- Same people as private.notify_management, using the employee's company (this runs inside someone's time-in).
    INSERT INTO public.notifications (organization_id, user_id, kind, title, body, link, created_by)
    SELECT DISTINCT v_org, u.id, 'IR_DRAFT', 'Tardiness IR ready to review',
      left(v_name || ' has ' || v_total || ' late minutes this cutoff (limit ' || v_limit || '). Review and issue the IR.', 1000), '/incidents/' || v_id, NULL::uuid
    FROM public.app_users u JOIN public.role_grants g ON g.user_id = u.id
    WHERE u.organization_id = v_org AND u.active AND coalesce(u.join_status, 'APPROVED') = 'APPROVED'
      AND g.revoked_at IS NULL AND g.role_code IN ('OWNER','MANAGER') AND (g.branch_id IS NULL OR g.branch_id = v_branch);
  END IF;
END $$;

-- Check after every time-in.
CREATE OR REPLACE FUNCTION private.time_punch_tardiness() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.kind = 'IN' THEN PERFORM private.check_tardiness(NEW.employee_id, NEW.work_date); END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS time_punch_tardiness ON public.time_punches;
CREATE TRIGGER time_punch_tardiness AFTER INSERT ON public.time_punches FOR EACH ROW EXECUTE FUNCTION private.time_punch_tardiness();

-- Owners set the limit. The current cutoff is re-checked right away.
CREATE OR REPLACE FUNCTION public.set_ir_late_limit(p_minutes integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_old integer; e record; v_today date := (now() AT TIME ZONE 'Asia/Manila')::date;
BEGIN
  IF NOT private.has_role(ARRAY['OWNER'], NULL) THEN RETURN private.deny(NULL, 'ir_limit'); END IF;
  IF p_minutes IS NULL OR p_minutes NOT BETWEEN 1 AND 1440 THEN RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST'); END IF;
  SELECT ir_late_minutes INTO v_old FROM public.organizations WHERE id = private.current_org_id();
  UPDATE public.organizations SET ir_late_minutes = p_minutes WHERE id = private.current_org_id();
  FOR e IN SELECT id FROM public.employees WHERE organization_id = private.current_org_id() AND active LOOP
    PERFORM private.check_tardiness(e.id, v_today);
  END LOOP;
  PERFORM private.audit(NULL, 'IR_LIMIT_SET', 'organization', private.current_org_id()::text,
    jsonb_build_object('minutes', v_old), jsonb_build_object('minutes', p_minutes));
  RETURN jsonb_build_object('ok', true);
END $$;

-- Manager or owner: issue the draft to the employee (with an optional note), or dismiss it.
CREATE OR REPLACE FUNCTION public.issue_ir(p_id uuid, p_issue boolean, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.incident_reports%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.incident_reports WHERE id = p_id AND organization_id = private.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF NOT private.can_schedule(r.employee_id) THEN RETURN private.deny(r.branch_id, 'incident_report'); END IF;
  IF r.employee_id = private.my_employee_id() THEN RETURN private.deny(r.branch_id, 'incident_report'); END IF;
  IF r.state <> 'DRAFT' THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_PENDING'); END IF;
  IF NOT coalesce(p_issue, false) AND length(btrim(coalesce(p_note, ''))) < 3 THEN RETURN jsonb_build_object('ok', false, 'error', 'REASON_REQUIRED'); END IF;
  UPDATE public.incident_reports SET state = CASE WHEN p_issue THEN 'ISSUED' ELSE 'DISMISSED' END,
    issue_note = nullif(left(btrim(coalesce(p_note, '')), 1000), ''), issued_by = private.current_user_id(), issued_at = now(), updated_at = now()
  WHERE id = p_id;
  IF p_issue THEN
    PERFORM private.notify_employee(r.employee_id, 'IR_ISSUED', 'Incident report: tardiness',
      'You were late ' || r.late_minutes || ' minutes in total from ' || to_char(r.period_start, 'Mon FMDD') || ' to ' || to_char(r.period_end, 'Mon FMDD') ||
      '. Please read it and write your explanation.', '/incidents/' || p_id);
  END IF;
  PERFORM private.audit(r.branch_id, CASE WHEN p_issue THEN 'IR_ISSUED' ELSE 'IR_DISMISSED' END, 'incident_report', p_id::text, NULL, NULL);
  RETURN jsonb_build_object('ok', true);
END $$;

-- The employee writes their explanation (once).
CREATE OR REPLACE FUNCTION public.explain_ir(p_id uuid, p_text text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.incident_reports%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.incident_reports WHERE id = p_id AND organization_id = private.current_org_id() FOR UPDATE;
  IF NOT FOUND OR r.employee_id IS DISTINCT FROM private.my_employee_id() THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF r.state <> 'ISSUED' THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_PENDING'); END IF;
  IF length(btrim(coalesce(p_text, ''))) < 3 THEN RETURN jsonb_build_object('ok', false, 'error', 'REASON_REQUIRED'); END IF;
  UPDATE public.incident_reports SET state = 'EXPLAINED', explanation = left(btrim(p_text), 2000), explained_at = now(), updated_at = now() WHERE id = p_id;
  PERFORM private.notify_management(r.branch_id, 'IR_EXPLAINED', 'IR explanation received',
    coalesce((SELECT full_name FROM public.employees WHERE id = r.employee_id), 'Someone') || ' answered IR no. ' || r.ir_no || '. Close it with the action taken.', '/incidents/' || p_id);
  PERFORM private.audit(r.branch_id, 'IR_EXPLAINED', 'incident_report', p_id::text, NULL, NULL);
  RETURN jsonb_build_object('ok', true);
END $$;

-- Manager or owner closes it with the action taken (e.g. verbal warning, written warning).
CREATE OR REPLACE FUNCTION public.close_ir(p_id uuid, p_action text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.incident_reports%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.incident_reports WHERE id = p_id AND organization_id = private.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF NOT private.can_schedule(r.employee_id) OR r.employee_id = private.my_employee_id() THEN RETURN private.deny(r.branch_id, 'incident_report'); END IF;
  IF r.state NOT IN ('ISSUED','EXPLAINED') THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_PENDING'); END IF;
  IF length(btrim(coalesce(p_action, ''))) < 3 THEN RETURN jsonb_build_object('ok', false, 'error', 'REASON_REQUIRED'); END IF;
  UPDATE public.incident_reports SET state = 'CLOSED', action_taken = left(btrim(p_action), 1000), closed_by = private.current_user_id(), closed_at = now(), updated_at = now()
  WHERE id = p_id;
  PERFORM private.notify_employee(r.employee_id, 'IR_CLOSED', 'Incident report closed', 'Action taken: ' || left(btrim(p_action), 300), '/incidents/' || p_id);
  PERFORM private.audit(r.branch_id, 'IR_CLOSED', 'incident_report', p_id::text, NULL, jsonb_build_object('action', left(btrim(p_action), 1000)));
  RETURN jsonb_build_object('ok', true);
END $$;

-- Names for the IR pages (staff can't read every employee row).
CREATE OR REPLACE FUNCTION public.incident_list() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object('limit', (SELECT ir_late_minutes FROM public.organizations WHERE id = private.current_org_id()),
    'reports', coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'ir_no', r.ir_no, 'employee_id', r.employee_id, 'name', e.full_name, 'position', e.position,
      'branch', b.name, 'period_start', r.period_start, 'period_end', r.period_end, 'late_minutes', r.late_minutes, 'late_days', r.late_days,
      'limit_minutes', r.limit_minutes, 'details', r.details, 'state', r.state, 'issue_note', r.issue_note, 'issued_by', iu.display_name, 'issued_at', r.issued_at,
      'explanation', r.explanation, 'explained_at', r.explained_at, 'action_taken', r.action_taken, 'closed_by', cu.display_name, 'closed_at', r.closed_at,
      'created_at', r.created_at, 'mine', r.employee_id = private.my_employee_id(),
      'can_manage', private.can_schedule(r.employee_id) AND r.employee_id IS DISTINCT FROM private.my_employee_id())
      ORDER BY r.created_at DESC), '[]'::jsonb))
  FROM public.incident_reports r JOIN public.employees e ON e.id = r.employee_id
  LEFT JOIN public.branches b ON b.id = r.branch_id
  LEFT JOIN public.app_users iu ON iu.id = r.issued_by LEFT JOIN public.app_users cu ON cu.id = r.closed_by
  WHERE r.organization_id = private.current_org_id()
    AND (private.can_schedule(r.employee_id) OR (r.employee_id = private.my_employee_id() AND r.state <> 'DRAFT'))
$$;

REVOKE ALL ON FUNCTION private.cutoff_of(date), private.late_days(uuid, date, date), private.check_tardiness(uuid, date),
  public.set_ir_late_limit(integer), public.issue_ir(uuid, boolean, text), public.explain_ir(uuid, text), public.close_ir(uuid, text),
  public.incident_list() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_ir_late_limit(integer), public.issue_ir(uuid, boolean, text), public.explain_ir(uuid, text),
  public.close_ir(uuid, text), public.incident_list() TO authenticated;
