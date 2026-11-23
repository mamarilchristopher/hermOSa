-- HERMOSA OS 0012: employee details filled in by staff, approved by the owner (owner request 2026-11-23).
-- Staff (and new joiners still waiting for approval) send their details. Nothing reaches the employee
-- record until an owner reviews it, optionally corrects it, and approves. Government IDs and bank details
-- are readable only by owners and by the person themself. Audit entries never copy the details.
-- Position is not part of the form: the owner assigns it.

ALTER TABLE public.employees ADD COLUMN hire_date date;

CREATE TABLE public.employee_detail_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  user_id uuid NOT NULL REFERENCES public.app_users(id),
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object' AND pg_column_size(data) <= 20000),
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','APPROVED','RETURNED','SUPERSEDED')),
  note text CHECK (note IS NULL OR length(note) <= 500),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES public.app_users(id),
  decided_at timestamptz
);
CREATE UNIQUE INDEX employee_detail_one_pending ON public.employee_detail_submissions (user_id) WHERE state = 'PENDING';

-- The approved, current details for an employee.
CREATE TABLE public.employee_details (
  employee_id uuid PRIMARY KEY REFERENCES public.employees(id),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object' AND pg_column_size(data) <= 20000),
  submission_id uuid REFERENCES public.employee_detail_submissions(id),
  approved_by uuid NOT NULL REFERENCES public.app_users(id),
  approved_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.employee_detail_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_details ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.employee_detail_submissions, public.employee_details TO authenticated;
CREATE POLICY detail_submissions_read ON public.employee_detail_submissions FOR SELECT TO authenticated
  USING (organization_id = private.current_org_id()
         AND (user_id = private.current_user_id() OR private.has_role(ARRAY['OWNER'], NULL)));
CREATE POLICY employee_details_read ON public.employee_details FOR SELECT TO authenticated
  USING (organization_id = private.current_org_id()
         AND (private.has_role(ARRAY['OWNER'], NULL)
              OR EXISTS (SELECT 1 FROM public.employees e WHERE e.id = employee_id AND e.app_user_id = private.current_user_id())));

CREATE FUNCTION private.details_complete(d jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT jsonb_typeof(d) = 'object'
     AND coalesce(btrim(d ->> 'first_name'), '') <> '' AND coalesce(btrim(d ->> 'last_name'), '') <> ''
     AND coalesce(d ->> 'consent', '') = 'yes'
     AND NOT EXISTS (SELECT 1 FROM jsonb_each(d) kv WHERE jsonb_typeof(kv.value) <> 'string' OR length(kv.value #>> '{}') > 600)
$$;

-- Staff send (or re-send) their details. A newer copy replaces one still waiting.
CREATE FUNCTION public.submit_employee_details(p_data jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_me uuid := private.current_user_id(); v_id uuid;
BEGIN
  IF v_me IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF p_data IS NULL OR NOT private.details_complete(p_data) OR pg_column_size(p_data) > 20000 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
  END IF;
  UPDATE public.employee_detail_submissions SET state = 'SUPERSEDED', decided_at = now()
  WHERE user_id = v_me AND state = 'PENDING';
  INSERT INTO public.employee_detail_submissions (organization_id, user_id, data)
  VALUES (private.current_org_id(), v_me, p_data) RETURNING id INTO v_id;
  PERFORM private.audit(NULL, 'DETAILS_SUBMITTED', 'employee_detail_submission', v_id::text, NULL, NULL);
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END $$;

-- Owner approves (optionally with corrections) or sends back with a note.
-- Approving applies the details: name, hire date and the full approved copy on the employee record.
CREATE FUNCTION public.decide_employee_details(p_submission uuid, p_approve boolean, p_data jsonb, p_full_name text, p_note text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_me uuid := private.current_user_id();
  s public.employee_detail_submissions%ROWTYPE;
  v_emp uuid; v_data jsonb; v_hire date;
BEGIN
  IF v_me IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT private.has_role(ARRAY['OWNER'], NULL) THEN
    RETURN private.deny(NULL, 'employee_details', CASE WHEN private.has_mfa() THEN 'FORBIDDEN' ELSE 'MFA_REQUIRED' END);
  END IF;
  SELECT * INTO s FROM public.employee_detail_submissions
  WHERE id = p_submission AND organization_id = private.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF s.state <> 'PENDING' THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_PENDING'); END IF;

  IF NOT coalesce(p_approve, false) THEN
    IF length(btrim(coalesce(p_note, ''))) < 3 THEN RETURN jsonb_build_object('ok', false, 'error', 'NOTE_REQUIRED'); END IF;
    UPDATE public.employee_detail_submissions SET state = 'RETURNED', note = left(btrim(p_note), 500), decided_by = v_me, decided_at = now()
    WHERE id = s.id;
    PERFORM private.audit(NULL, 'DETAILS_RETURNED', 'employee_detail_submission', s.id::text, NULL, NULL);
    RETURN jsonb_build_object('ok', true);
  END IF;

  SELECT id INTO v_emp FROM public.employees WHERE app_user_id = s.user_id;
  IF v_emp IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NO_EMPLOYEE_RECORD'); END IF;
  v_data := coalesce(p_data, s.data);
  IF NOT private.details_complete(v_data) OR pg_column_size(v_data) > 20000 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
  END IF;
  IF length(btrim(coalesce(p_full_name, ''))) NOT BETWEEN 2 AND 120 THEN RETURN jsonb_build_object('ok', false, 'error', 'NAME_REQUIRED'); END IF;
  IF coalesce(v_data ->> 'hire_date', '') ~ '^\d{4}-\d{2}-\d{2}$' THEN v_hire := (v_data ->> 'hire_date')::date; END IF;

  UPDATE public.employee_detail_submissions SET state = 'APPROVED', data = v_data, decided_by = v_me, decided_at = now(),
    note = nullif(left(btrim(coalesce(p_note, '')), 500), '')
  WHERE id = s.id;
  INSERT INTO public.employee_details (employee_id, organization_id, data, submission_id, approved_by)
  VALUES (v_emp, s.organization_id, v_data, s.id, v_me)
  ON CONFLICT (employee_id) DO UPDATE SET data = EXCLUDED.data, submission_id = EXCLUDED.submission_id,
    approved_by = EXCLUDED.approved_by, approved_at = now();
  UPDATE public.employees SET full_name = btrim(p_full_name), hire_date = coalesce(v_hire, hire_date) WHERE id = v_emp;
  PERFORM private.audit(NULL, 'DETAILS_APPROVED', 'employee', v_emp::text, NULL,
    jsonb_build_object('submission_id', s.id, 'corrected', p_data IS NOT NULL AND p_data <> s.data));
  RETURN jsonb_build_object('ok', true, 'employee_id', v_emp);
END $$;

REVOKE ALL ON FUNCTION public.submit_employee_details(jsonb), public.decide_employee_details(uuid, boolean, jsonb, text, text),
  private.details_complete(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_employee_details(jsonb), public.decide_employee_details(uuid, boolean, jsonb, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION private.details_complete(jsonb) TO authenticated;
