-- update-0033: owners and the General Manager can set or correct any staff member's start date (CHRIS, Nov 25 2026).
-- The start date (employees.hire_date) used to change only when a staff details submission was approved.
-- Every change is written to the audit log with the old and new date. Safe to run more than once.

CREATE OR REPLACE FUNCTION public.set_employee_start_date(p_employee uuid, p_date date)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  e public.employees%ROWTYPE;
BEGIN
  IF private.current_user_id() IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT (private.has_role(ARRAY['OWNER'], NULL) OR private.is_gm()) THEN
    RETURN private.deny(NULL, 'employee_start_date', CASE WHEN private.has_mfa() THEN 'FORBIDDEN' ELSE 'MFA_REQUIRED' END);
  END IF;
  SELECT * INTO e FROM public.employees WHERE id = p_employee AND organization_id = private.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF p_date IS NOT NULL AND (p_date < DATE '2000-01-01' OR p_date > (now() AT TIME ZONE 'Asia/Manila')::date + 366) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_START_DATE');
  END IF;
  IF e.hire_date IS NOT DISTINCT FROM p_date THEN RETURN jsonb_build_object('ok', true, 'changed', false); END IF;
  UPDATE public.employees SET hire_date = p_date WHERE id = e.id;
  PERFORM private.audit(e.branch_id, 'START_DATE_SET', 'employee', e.id::text,
    jsonb_build_object('hire_date', e.hire_date), jsonb_build_object('hire_date', p_date));
  RETURN jsonb_build_object('ok', true, 'changed', true);
END $$;
REVOKE ALL ON FUNCTION public.set_employee_start_date(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_employee_start_date(uuid, date) TO authenticated;
