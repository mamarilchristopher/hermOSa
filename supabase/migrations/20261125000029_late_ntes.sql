-- HERMOSA OS 0029: Late NTEs (Notice to Explain) and IRs issued from them (owner request 2026-11-25). Safe to run more than once.
-- * Grace period 15 minutes: a time-in more than 15 minutes after the shift start is late.
-- * Every late time-in creates a Late NTE right away. The employee must type their explanation (urgent on their Home).
-- * Owners and the GM see a tardiness tracker: Late NTEs per person this month.
-- * From a person's NTE page, management issues an IR covering their Late NTEs not yet in an IR. The employee
--   acknowledges it online and writes a response (urgent on their Home). Each IR is kept as a PDF in private storage.
-- * This replaces the automatic IR drafts at 60 late minutes per cutoff (older IRs stay as they are).

ALTER TABLE public.organizations ALTER COLUMN late_grace_minutes SET DEFAULT 15;
UPDATE public.organizations SET late_grace_minutes = 15;

CREATE TABLE IF NOT EXISTS public.late_ntes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  nte_no integer NOT NULL,
  employee_id uuid NOT NULL REFERENCES public.employees(id),
  branch_id uuid REFERENCES public.branches(id),
  work_date date NOT NULL,
  shift_start time NOT NULL,
  time_in timestamptz NOT NULL,
  late_minutes integer NOT NULL CHECK (late_minutes > 0),
  grace_minutes integer NOT NULL,
  punch_id uuid REFERENCES public.time_punches(id),
  state text NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN','EXPLAINED','VOID')),
  explanation text CHECK (explanation IS NULL OR length(explanation) <= 2000),
  explained_at timestamptz,
  void_reason text CHECK (void_reason IS NULL OR length(void_reason) <= 500),
  voided_by uuid REFERENCES public.app_users(id), voided_at timestamptz,
  ir_id uuid REFERENCES public.incident_reports(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, work_date),
  UNIQUE (organization_id, nte_no)
);
CREATE INDEX IF NOT EXISTS late_ntes_month ON public.late_ntes (organization_id, work_date);
ALTER TABLE public.late_ntes ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.late_ntes TO authenticated;
DROP POLICY IF EXISTS late_ntes_read ON public.late_ntes;
CREATE POLICY late_ntes_read ON public.late_ntes FOR SELECT TO authenticated
  USING (organization_id = private.current_org_id() AND (private.can_schedule(employee_id) OR employee_id = private.my_employee_id()));

-- IRs made from Late NTEs: a month, any number per person, acknowledged online, kept as a PDF.
ALTER TABLE public.incident_reports DROP CONSTRAINT IF EXISTS incident_reports_employee_id_kind_period_start_key;
ALTER TABLE public.incident_reports ADD COLUMN IF NOT EXISTS basis text NOT NULL DEFAULT 'CUTOFF_MINUTES'
  CHECK (basis IN ('CUTOFF_MINUTES','LATE_NTE'));
ALTER TABLE public.incident_reports ADD COLUMN IF NOT EXISTS acknowledged_at timestamptz;
ALTER TABLE public.incident_reports ADD COLUMN IF NOT EXISTS pdf_path text;
ALTER TABLE public.incident_reports ADD COLUMN IF NOT EXISTS pdf_saved_at timestamptz;

-- The NTE for a time-in, if it's late. Only the first time-in of a day on a published working day counts.
CREATE OR REPLACE FUNCTION private.make_late_nte(p_punch uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE t public.time_punches%ROWTYPE; s public.shifts%ROWTYPE; v_grace integer; v_late integer; v_id uuid; v_name text;
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
  PERFORM pg_advisory_xact_lock(hashtext('nte_no:' || t.organization_id::text));
  INSERT INTO public.late_ntes (organization_id, nte_no, employee_id, branch_id, work_date, shift_start, time_in, late_minutes, grace_minutes, punch_id)
  VALUES (t.organization_id, coalesce((SELECT max(nte_no) FROM public.late_ntes WHERE organization_id = t.organization_id), 0) + 1,
          t.employee_id, coalesce(s.branch_id, t.branch_id), t.work_date, s.start_time, t.punched_at, v_late, coalesce(v_grace, 0), t.id)
  ON CONFLICT (employee_id, work_date) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN
    INSERT INTO public.notifications (organization_id, user_id, kind, title, body, link, created_by)
    SELECT e.organization_id, e.app_user_id, 'NTE_LATE', 'Late NTE: please explain',
      'You timed in ' || v_late || ' minutes after your ' || to_char(s.start_time, 'FMHH12:MI AM') || ' start. Write your explanation now.', '/nte', NULL
    FROM public.employees e WHERE e.id = t.employee_id AND e.app_user_id IS NOT NULL;
  END IF;
  RETURN v_id;
END $$;

-- After every time-in: make the Late NTE. The old cutoff-minutes IR drafts are no longer made.
CREATE OR REPLACE FUNCTION private.time_punch_tardiness() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.kind = 'IN' THEN PERFORM private.make_late_nte(NEW.id); END IF;
  RETURN NULL;
END $$;

-- The employee explains (once).
CREATE OR REPLACE FUNCTION public.explain_nte(p_id uuid, p_text text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE n public.late_ntes%ROWTYPE;
BEGIN
  SELECT * INTO n FROM public.late_ntes WHERE id = p_id AND organization_id = private.current_org_id() FOR UPDATE;
  IF NOT FOUND OR n.employee_id IS DISTINCT FROM private.my_employee_id() THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF n.state <> 'OPEN' THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_PENDING'); END IF;
  IF length(btrim(coalesce(p_text, ''))) < 3 THEN RETURN jsonb_build_object('ok', false, 'error', 'REASON_REQUIRED'); END IF;
  UPDATE public.late_ntes SET state = 'EXPLAINED', explanation = left(btrim(p_text), 2000), explained_at = now() WHERE id = p_id;
  PERFORM private.audit(n.branch_id, 'NTE_EXPLAINED', 'late_nte', p_id::text, NULL, NULL);
  RETURN jsonb_build_object('ok', true);
END $$;

-- Management cancels an NTE that was a mistake (wrong schedule, approved errand). It then never counts.
CREATE OR REPLACE FUNCTION public.void_nte(p_id uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE n public.late_ntes%ROWTYPE;
BEGIN
  SELECT * INTO n FROM public.late_ntes WHERE id = p_id AND organization_id = private.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF NOT private.can_schedule(n.employee_id) OR n.employee_id = private.my_employee_id() THEN RETURN private.deny(n.branch_id, 'late_nte'); END IF;
  IF n.state = 'VOID' OR n.ir_id IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_PENDING'); END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 3 THEN RETURN jsonb_build_object('ok', false, 'error', 'REASON_REQUIRED'); END IF;
  UPDATE public.late_ntes SET state = 'VOID', void_reason = left(btrim(p_reason), 500), voided_by = private.current_user_id(), voided_at = now() WHERE id = p_id;
  PERFORM private.audit(n.branch_id, 'NTE_VOIDED', 'late_nte', p_id::text, NULL, jsonb_build_object('reason', left(btrim(p_reason), 500)));
  RETURN jsonb_build_object('ok', true);
END $$;

-- Late NTEs for a month: the tracker (everyone management can see) or one person's page.
CREATE OR REPLACE FUNCTION public.late_nte_list(p_month date, p_employee uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH m AS (SELECT date_trunc('month', coalesce(p_month, (now() AT TIME ZONE 'Asia/Manila')::date))::date AS s),
  n AS (
    SELECT x.*, e.full_name, e.position, b.name AS branch,
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
    'ntes', coalesce((SELECT jsonb_agg(jsonb_build_object('id', id, 'nte_no', nte_no, 'employee_id', employee_id, 'name', full_name, 'position', position,
      'branch', branch, 'work_date', work_date, 'shift_start', to_char(shift_start, 'HH24:MI'), 'time_in', to_char(time_in AT TIME ZONE 'Asia/Manila', 'HH24:MI'),
      'late_minutes', late_minutes, 'state', state, 'explanation', explanation, 'explained_at', explained_at, 'void_reason', void_reason,
      'ir_id', ir_id, 'mine', mine, 'can_manage', can_manage) ORDER BY work_date DESC, nte_no DESC) FROM n), '[]'::jsonb))
$$;

-- Management issues an IR from a person's Late NTEs this month that aren't in an IR yet.
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
  WHERE n.employee_id = p_employee AND n.work_date BETWEEN v_s AND v_e AND n.state <> 'VOID' AND n.ir_id IS NULL;
  IF v_n = 0 THEN RETURN jsonb_build_object('ok', false, 'error', 'NOTHING_TO_ISSUE'); END IF;
  SELECT branch_id INTO v_branch FROM public.employees WHERE id = p_employee;
  PERFORM pg_advisory_xact_lock(hashtext('ir_no:' || v_org::text));
  INSERT INTO public.incident_reports (organization_id, ir_no, employee_id, branch_id, period_start, period_end, late_minutes, late_days,
    limit_minutes, details, state, basis, issue_note, issued_by, issued_at)
  VALUES (v_org, coalesce((SELECT max(ir_no) FROM public.incident_reports WHERE organization_id = v_org), 0) + 1, p_employee, v_branch,
    v_s, v_e, v_min, v_n, 0, v_days, 'ISSUED', 'LATE_NTE', nullif(left(btrim(coalesce(p_note, '')), 1000), ''), private.current_user_id(), now())
  RETURNING id INTO v_id;
  UPDATE public.late_ntes SET ir_id = v_id
  WHERE employee_id = p_employee AND work_date BETWEEN v_s AND v_e AND state <> 'VOID' AND ir_id IS NULL;
  PERFORM private.notify_employee(p_employee, 'IR_ISSUED', 'URGENT: Incident report issued',
    'An IR for ' || v_n || ' late arrival' || CASE WHEN v_n = 1 THEN '' ELSE 's' END || ' in ' || to_char(v_s, 'FMMonth YYYY') ||
    ' was issued to you. Please acknowledge it and write your response.', '/incidents/' || v_id);
  PERFORM private.audit(v_branch, 'IR_ISSUED', 'incident_report', v_id::text, NULL, jsonb_build_object('basis', 'LATE_NTE', 'ntes', v_n));
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END $$;

-- The employee acknowledges the IR and writes their response (once).
CREATE OR REPLACE FUNCTION public.acknowledge_ir(p_id uuid, p_text text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.incident_reports%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.incident_reports WHERE id = p_id AND organization_id = private.current_org_id() FOR UPDATE;
  IF NOT FOUND OR r.employee_id IS DISTINCT FROM private.my_employee_id() THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF r.state <> 'ISSUED' THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_PENDING'); END IF;
  IF length(btrim(coalesce(p_text, ''))) < 3 THEN RETURN jsonb_build_object('ok', false, 'error', 'REASON_REQUIRED'); END IF;
  UPDATE public.incident_reports SET state = 'EXPLAINED', explanation = left(btrim(p_text), 2000), explained_at = now(),
    acknowledged_at = now(), updated_at = now() WHERE id = p_id;
  PERFORM private.notify_management(r.branch_id, 'IR_EXPLAINED', 'IR acknowledged',
    coalesce((SELECT full_name FROM public.employees WHERE id = r.employee_id), 'Someone') || ' acknowledged IR no. ' || r.ir_no || ' and responded. Close it with the action taken.', '/incidents/' || p_id);
  PERFORM private.audit(r.branch_id, 'IR_ACKNOWLEDGED', 'incident_report', p_id::text, NULL, NULL);
  RETURN jsonb_build_object('ok', true);
END $$;

-- The app saved the IR's PDF in storage (incident-reports/<ir id>.pdf).
CREATE OR REPLACE FUNCTION public.mark_ir_pdf(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.incident_reports%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.incident_reports WHERE id = p_id AND organization_id = private.current_org_id() FOR UPDATE;
  IF NOT FOUND OR NOT private.can_schedule(r.employee_id) THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  UPDATE public.incident_reports SET pdf_path = p_id::text || '.pdf', pdf_saved_at = now() WHERE id = p_id;
  RETURN jsonb_build_object('ok', true);
END $$;

-- incident_list, now with the new fields.
CREATE OR REPLACE FUNCTION public.incident_list() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object('limit', (SELECT ir_late_minutes FROM public.organizations WHERE id = private.current_org_id()),
    'reports', coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'ir_no', r.ir_no, 'employee_id', r.employee_id, 'name', e.full_name, 'position', e.position,
      'branch', b.name, 'period_start', r.period_start, 'period_end', r.period_end, 'late_minutes', r.late_minutes, 'late_days', r.late_days,
      'limit_minutes', r.limit_minutes, 'details', r.details, 'state', r.state, 'issue_note', r.issue_note, 'issued_by', iu.display_name, 'issued_at', r.issued_at,
      'explanation', r.explanation, 'explained_at', r.explained_at, 'action_taken', r.action_taken, 'closed_by', cu.display_name, 'closed_at', r.closed_at,
      'created_at', r.created_at, 'updated_at', r.updated_at, 'basis', r.basis, 'acknowledged_at', r.acknowledged_at,
      'pdf_path', r.pdf_path, 'pdf_saved_at', r.pdf_saved_at, 'mine', r.employee_id = private.my_employee_id(),
      'can_manage', private.can_schedule(r.employee_id) AND r.employee_id IS DISTINCT FROM private.my_employee_id())
      ORDER BY r.created_at DESC), '[]'::jsonb))
  FROM public.incident_reports r JOIN public.employees e ON e.id = r.employee_id
  LEFT JOIN public.branches b ON b.id = r.branch_id
  LEFT JOIN public.app_users iu ON iu.id = r.issued_by
  LEFT JOIN public.app_users cu ON cu.id = r.closed_by
  WHERE r.organization_id = private.current_org_id()
    AND (private.can_schedule(r.employee_id) OR (r.employee_id = private.my_employee_id() AND r.state <> 'DRAFT'))
$$;

-- Private PDF folder for IRs. Management saves; management and the employee read. Skipped where Storage isn't installed (tests).
CREATE OR REPLACE FUNCTION private.ir_file_access(p_name text, p_write boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.incident_reports r
    WHERE p_name ~ '^[0-9a-f-]{36}\.pdf$' AND r.id = substr(p_name, 1, 36)::uuid AND r.organization_id = private.current_org_id()
      AND (private.can_schedule(r.employee_id) OR (NOT p_write AND r.employee_id = private.my_employee_id())))
$$;
DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES ('incident-reports', 'incident-reports', false, 5242880, ARRAY['application/pdf'])
    ON CONFLICT (id) DO NOTHING;
    EXECUTE 'DROP POLICY IF EXISTS ir_pdf_insert ON storage.objects';
    EXECUTE $p$CREATE POLICY ir_pdf_insert ON storage.objects FOR INSERT TO authenticated
      WITH CHECK (bucket_id = 'incident-reports' AND private.ir_file_access(name, true))$p$;
    EXECUTE 'DROP POLICY IF EXISTS ir_pdf_update ON storage.objects';
    EXECUTE $p$CREATE POLICY ir_pdf_update ON storage.objects FOR UPDATE TO authenticated
      USING (bucket_id = 'incident-reports' AND private.ir_file_access(name, true))
      WITH CHECK (bucket_id = 'incident-reports' AND private.ir_file_access(name, true))$p$;
    EXECUTE 'DROP POLICY IF EXISTS ir_pdf_read ON storage.objects';
    EXECUTE $p$CREATE POLICY ir_pdf_read ON storage.objects FOR SELECT TO authenticated
      USING (bucket_id = 'incident-reports' AND private.ir_file_access(name, false))$p$;
  END IF;
END $$;

REVOKE ALL ON FUNCTION private.make_late_nte(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.explain_nte(uuid, text), public.void_nte(uuid, text), public.late_nte_list(date, uuid),
  public.issue_late_ir(uuid, date, text), public.acknowledge_ir(uuid, text), public.mark_ir_pdf(uuid), public.incident_list(),
  private.ir_file_access(text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.explain_nte(uuid, text), public.void_nte(uuid, text), public.late_nte_list(date, uuid),
  public.issue_late_ir(uuid, date, text), public.acknowledge_ir(uuid, text), public.mark_ir_pdf(uuid), public.incident_list(),
  private.ir_file_access(text, boolean) TO authenticated;
