-- update-0045: when a join request is approved, link the login to the existing staff record with the same
-- first and last name (if exactly one active, unlinked record matches) instead of creating a duplicate.

-- "Ma. Lea R. Cruz" and "Lea Cruz" both become "lea cruz": lowercase, letters only, a leading "ma"/"maria" dropped,
-- then first word + last word.
CREATE OR REPLACE FUNCTION private.name_key(p_name text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  WITH w AS (
    SELECT array_remove(regexp_split_to_array(btrim(regexp_replace(lower(coalesce(p_name, '')), '[^a-zñ ]+', ' ', 'g')), '\s+'), '') AS a
  ), x AS (
    SELECT CASE WHEN array_length(a, 1) > 2 AND a[1] IN ('ma', 'maria') THEN a[2:] ELSE a END AS a FROM w
  )
  SELECT CASE WHEN coalesce(array_length(a, 1), 0) < 2 THEN coalesce(a[1], '') ELSE a[1] || ' ' || a[array_length(a, 1)] END FROM x
$$;

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
  IF p_level IS NULL OR p_level NOT IN ('OWNER','GM','SENIOR_CMA','CMA','TRAINEE','CSR','MANAGER','CASHIER','FINANCE','HR') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'LEVEL_REQUIRED');
  END IF;
  IF NOT v_owner AND p_level = 'OWNER' THEN
    RETURN private.deny(NULL, 'join_request', 'OWNER_ONLY_LEVEL');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = p_branch AND organization_id = v_org AND kind IN ('CLINIC','WFH')) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BRANCH_REQUIRED');
  END IF;
  v_role := CASE p_level WHEN 'GM' THEN 'MANAGER' WHEN 'SENIOR_CMA' THEN 'CLINICIAN' WHEN 'CMA' THEN 'CLINICIAN' WHEN 'TRAINEE' THEN 'CLINICIAN' ELSE p_level END;
  v_scope := CASE WHEN p_level IN ('OWNER','GM','FINANCE','HR','CSR') THEN NULL ELSE p_branch END;

  INSERT INTO public.role_grants (user_id, role_code, branch_id, granted_by) VALUES (p_user, v_role, v_scope, v_me)
  ON CONFLICT DO NOTHING;
  SELECT id INTO v_emp FROM public.employees WHERE app_user_id = p_user;
  -- Link to an existing staff record with the same first and last name (exactly one, active, not yet linked)
  -- instead of creating a duplicate that would split their services, commissions and time-ins.
  IF v_emp IS NULL THEN
    SELECT CASE WHEN count(*) = 1 THEN min(e.id::text)::uuid END INTO v_emp FROM public.employees e
    WHERE e.organization_id = v_org AND e.active AND e.app_user_id IS NULL
      AND private.name_key(e.full_name) <> '' AND private.name_key(e.full_name) = private.name_key(u.display_name);
    IF v_emp IS NOT NULL THEN UPDATE public.employees SET app_user_id = p_user WHERE id = v_emp; END IF;
  END IF;
  IF v_emp IS NULL THEN
    INSERT INTO public.employees (organization_id, branch_id, full_name, position, commission_eligible, app_user_id, created_by)
    VALUES (v_org, p_branch, u.display_name,
            coalesce(nullif(btrim(coalesce(p_position, '')), ''), CASE p_level WHEN 'OWNER' THEN 'Owner' WHEN 'GM' THEN 'General Manager' WHEN 'SENIOR_CMA' THEN 'Senior CMA'
              WHEN 'CMA' THEN 'CMA' WHEN 'TRAINEE' THEN 'Trainee' WHEN 'CSR' THEN 'CSR' WHEN 'MANAGER' THEN 'Branch Manager' WHEN 'CASHIER' THEN 'Front desk'
              WHEN 'FINANCE' THEN 'Finance' ELSE 'HR' END),
            coalesce(p_commission, p_level IN ('SENIOR_CMA','CMA')), p_user, v_me)
    RETURNING id INTO v_emp;
  END IF;
  UPDATE public.app_users SET join_status = 'APPROVED' WHERE id = p_user;
  PERFORM private.audit(v_scope, 'JOIN_APPROVED', 'app_user', p_user::text, jsonb_build_object('join_status', 'PENDING'),
    jsonb_build_object('level', p_level, 'role', v_role, 'branch_id', v_scope, 'home_branch', p_branch, 'employee_id', v_emp));
  RETURN jsonb_build_object('ok', true, 'employee_id', v_emp);
END $$;
