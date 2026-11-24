-- update-0027: the General Manager (company-wide MANAGER, e.g. Geraldine) can accept or reject join requests.
-- The GM can approve staff levels only (Senior CMA, CMA, Trainee, Branch manager, Front desk).
-- Owner, GM, Finance and HR levels stay owner-only.

CREATE OR REPLACE FUNCTION private.can_approve_joins() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT private.has_role(ARRAY['OWNER'], NULL) OR private.has_role(ARRAY['MANAGER'], NULL)
$$;
REVOKE ALL ON FUNCTION private.can_approve_joins() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.can_approve_joins() TO authenticated;

-- The GM sees people who are waiting to join (only them, not every account).
DROP POLICY IF EXISTS users_read_pending ON public.app_users;
CREATE POLICY users_read_pending ON public.app_users FOR SELECT TO authenticated
  USING (organization_id = private.current_org_id() AND join_status = 'PENDING'
         AND private.has_role(ARRAY['MANAGER'], NULL));

CREATE OR REPLACE FUNCTION public.approve_join_request(p_user uuid, p_level text, p_branch uuid, p_position text, p_commission boolean)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_me uuid := private.current_user_id();
  v_org uuid := private.current_org_id();
  v_owner boolean := private.has_role(ARRAY['OWNER'], NULL);
  u public.app_users%ROWTYPE;
  v_role text; v_scope uuid; v_emp uuid;
BEGIN
  IF v_me IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT private.can_approve_joins() THEN
    RETURN private.deny(NULL, 'join_request', CASE WHEN private.has_mfa() THEN 'FORBIDDEN' ELSE 'MFA_REQUIRED' END);
  END IF;
  SELECT * INTO u FROM public.app_users WHERE id = p_user AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'UNKNOWN_USER'); END IF;
  IF u.join_status <> 'PENDING' THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_PENDING'); END IF;
  IF p_user = v_me THEN RETURN private.deny(NULL, 'join_request', 'SELF_ESCALATION_DENIED'); END IF;
  IF p_level IS NULL OR p_level NOT IN ('OWNER','GM','SENIOR_CMA','CMA','TRAINEE','MANAGER','CASHIER','FINANCE','HR') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'LEVEL_REQUIRED');
  END IF;
  IF NOT v_owner AND p_level NOT IN ('SENIOR_CMA','CMA','TRAINEE','MANAGER','CASHIER') THEN
    RETURN private.deny(NULL, 'join_request', 'OWNER_ONLY_LEVEL');
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

CREATE OR REPLACE FUNCTION public.reject_join_request(p_user uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_me uuid := private.current_user_id();
BEGIN
  IF v_me IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT private.can_approve_joins() THEN RETURN private.deny(NULL, 'join_request'); END IF;
  UPDATE public.app_users SET join_status = 'REJECTED', active = false
  WHERE id = p_user AND organization_id = private.current_org_id() AND join_status = 'PENDING' AND id <> v_me;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_PENDING'); END IF;
  PERFORM private.audit(NULL, 'JOIN_REJECTED', 'app_user', p_user::text, NULL, NULL);
  RETURN jsonb_build_object('ok', true);
END $$;

REVOKE ALL ON FUNCTION public.approve_join_request(uuid, text, uuid, text, boolean), public.reject_join_request(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_join_request(uuid, text, uuid, text, boolean), public.reject_join_request(uuid) TO authenticated;
