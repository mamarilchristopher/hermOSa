-- HERMOSA OS 0025: rules for "Suggest a week", and the Trainee staff level (owner requests 2026-11-25).
-- Safe to run more than once.
-- min = fewest people per branch for each weekday (Mon..Sun), days_off = days off per person per week.
ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS schedule_rules jsonb NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(schedule_rules) = 'object' AND pg_column_size(schedule_rules) <= 8000);

CREATE OR REPLACE FUNCTION public.schedule_rules() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT schedule_rules FROM public.organizations WHERE id = private.current_org_id() AND private.current_user_id() IS NOT NULL
$$;

-- Owners and the company-wide manager (GM) set the rules.
CREATE OR REPLACE FUNCTION public.save_schedule_rules(p_rules jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_old jsonb;
BEGIN
  IF NOT private.has_role(ARRAY['OWNER','MANAGER'], NULL) THEN RETURN private.deny(NULL, 'schedule_rules'); END IF;
  IF p_rules IS NULL OR jsonb_typeof(p_rules) <> 'object' OR pg_column_size(p_rules) > 8000
     OR coalesce((p_rules ->> 'days_off')::int, 1) NOT BETWEEN 0 AND 3 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
  END IF;
  SELECT schedule_rules INTO v_old FROM public.organizations WHERE id = private.current_org_id();
  UPDATE public.organizations SET schedule_rules = p_rules WHERE id = private.current_org_id();
  PERFORM private.audit(NULL, 'SCHEDULE_RULES_SET', 'organization', private.current_org_id()::text, v_old, p_rules);
  RETURN jsonb_build_object('ok', true);
EXCEPTION WHEN invalid_text_representation THEN RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
END $$;

REVOKE ALL ON FUNCTION public.schedule_rules(), public.save_schedule_rules(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.schedule_rules(), public.save_schedule_rules(jsonb) TO authenticated;

-- Trainee staff level (owner, 2026-11-25): works at the home branch like a CMA, not on commission by default.
CREATE OR REPLACE FUNCTION public.approve_join_request(p_user uuid, p_level text, p_branch uuid, p_position text, p_commission boolean)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_me uuid := private.current_user_id();
  v_org uuid := private.current_org_id();
  u public.app_users%ROWTYPE;
  v_role text; v_scope uuid; v_emp uuid;
BEGIN
  IF v_me IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT private.has_role(ARRAY['OWNER'], NULL) THEN
    RETURN private.deny(NULL, 'join_request', CASE WHEN private.has_mfa() THEN 'FORBIDDEN' ELSE 'MFA_REQUIRED' END);
  END IF;
  SELECT * INTO u FROM public.app_users WHERE id = p_user AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'UNKNOWN_USER'); END IF;
  IF u.join_status <> 'PENDING' THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_PENDING'); END IF;
  IF p_user = v_me THEN RETURN private.deny(NULL, 'join_request', 'SELF_ESCALATION_DENIED'); END IF;
  IF p_level IS NULL OR p_level NOT IN ('OWNER','GM','SENIOR_CMA','CMA','TRAINEE','MANAGER','CASHIER','FINANCE','HR') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'LEVEL_REQUIRED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = p_branch AND organization_id = v_org AND kind = 'CLINIC') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BRANCH_REQUIRED');
  END IF;
  v_role := CASE p_level WHEN 'GM' THEN 'MANAGER' WHEN 'SENIOR_CMA' THEN 'CLINICIAN' WHEN 'CMA' THEN 'CLINICIAN' WHEN 'TRAINEE' THEN 'CLINICIAN' ELSE p_level END;
  v_scope := CASE WHEN p_level IN ('OWNER','GM','FINANCE','HR') THEN NULL ELSE p_branch END;

  INSERT INTO public.role_grants (user_id, role_code, branch_id, granted_by) VALUES (p_user, v_role, v_scope, v_me)
  ON CONFLICT DO NOTHING;
  SELECT id INTO v_emp FROM public.employees WHERE app_user_id = p_user;
  IF v_emp IS NULL THEN
    INSERT INTO public.employees (organization_id, branch_id, full_name, position, commission_eligible, app_user_id, created_by)
    VALUES (v_org, p_branch, u.display_name,
            coalesce(nullif(btrim(coalesce(p_position, '')), ''), CASE p_level WHEN 'OWNER' THEN 'Owner' WHEN 'GM' THEN 'General Manager' WHEN 'SENIOR_CMA' THEN 'Senior CMA'
              WHEN 'CMA' THEN 'CMA' WHEN 'TRAINEE' THEN 'Trainee' WHEN 'MANAGER' THEN 'Branch Manager' WHEN 'CASHIER' THEN 'Front desk'
              WHEN 'FINANCE' THEN 'Finance' ELSE 'HR' END),
            coalesce(p_commission, p_level IN ('SENIOR_CMA','CMA')), p_user, v_me)
    RETURNING id INTO v_emp;
  END IF;
  UPDATE public.app_users SET join_status = 'APPROVED' WHERE id = p_user;
  PERFORM private.audit(v_scope, 'JOIN_APPROVED', 'app_user', p_user::text, jsonb_build_object('join_status', 'PENDING'),
    jsonb_build_object('level', p_level, 'role', v_role, 'branch_id', v_scope, 'home_branch', p_branch, 'employee_id', v_emp));
  RETURN jsonb_build_object('ok', true, 'employee_id', v_emp);
END $$;
