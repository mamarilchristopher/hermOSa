-- HERMOSA OS 0021: "View as" for owners and the general manager (owner request 2026-11-24).
-- Read-only look at any active staff member's Home: their to-dos (employee details, entries sent back,
-- unsigned commission, nothing logged today) and their details. Each look is written to the audit log.
-- Nothing can be changed from this view. Safe to run more than once.

-- Owners, or a company-wide MANAGER grant (the general manager).
CREATE OR REPLACE FUNCTION private.can_view_as() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT private.has_role(ARRAY['OWNER','MANAGER'], NULL)
$$;

CREATE OR REPLACE FUNCTION public.view_as_people() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN private.can_view_as() THEN coalesce((
    SELECT jsonb_agg(jsonb_build_object('id', u.id, 'name', coalesce(e.full_name, u.display_name), 'position', e.position)
                     ORDER BY coalesce(e.full_name, u.display_name))
    FROM public.app_users u
    LEFT JOIN LATERAL (SELECT full_name, position FROM public.employees x WHERE x.app_user_id = u.id ORDER BY x.active DESC LIMIT 1) e ON true
    WHERE u.organization_id = private.current_org_id() AND u.active AND coalesce(u.join_status, 'APPROVED') = 'APPROVED'
      AND u.id IS DISTINCT FROM private.current_user_id()), '[]'::jsonb)
  ELSE '[]'::jsonb END
$$;

CREATE OR REPLACE FUNCTION public.view_as(p_user uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_org uuid := private.current_org_id();
  v_today date := (now() AT TIME ZONE 'Asia/Manila')::date;
  u public.app_users%ROWTYPE; e public.employees%ROWTYPE; v_has_emp boolean;
BEGIN
  IF private.current_user_id() IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT private.can_view_as() THEN RETURN private.deny(NULL, 'view_as'); END IF;
  SELECT * INTO u FROM public.app_users WHERE id = p_user AND organization_id = v_org;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  SELECT * INTO e FROM public.employees WHERE app_user_id = p_user ORDER BY active DESC LIMIT 1;
  v_has_emp := FOUND;
  PERFORM private.audit(NULL, 'VIEW_AS', 'app_user', p_user::text, NULL, NULL);
  RETURN jsonb_build_object('ok', true,
    'name', coalesce(e.full_name, u.display_name),
    'email', u.email, 'joined_at', u.joined_at, 'active', u.active,
    'employee', CASE WHEN v_has_emp THEN jsonb_build_object('id', e.id, 'position', e.position, 'branch_id', e.branch_id,
                  'commission_eligible', e.commission_eligible) END,
    'roles', coalesce((SELECT jsonb_agg(jsonb_build_object('role', g.role_code, 'branch_id', g.branch_id))
                       FROM public.role_grants g WHERE g.user_id = p_user AND g.revoked_at IS NULL), '[]'::jsonb),
    'details_state', (SELECT s.state FROM public.employee_detail_submissions s WHERE s.user_id = p_user AND s.state <> 'SUPERSEDED'
                      ORDER BY s.submitted_at DESC LIMIT 1),
    'sent_back', (SELECT jsonb_build_object('count', count(*), 'latest', max(l.service_date)) FROM public.service_logs l
                  WHERE l.state = 'REJECTED' AND l.service_date >= v_today - 30
                    AND (l.created_by = p_user OR (v_has_emp AND e.id IN (l.performer_id, l.assistant_id)))),
    'unsigned', (SELECT jsonb_build_object('count', count(*), 'oldest', min(l.service_date), 'cents', coalesce(sum(c.amount_cents), 0))
                 FROM public.commission_lines c JOIN public.service_logs l ON l.id = c.service_log_id
                 WHERE v_has_emp AND c.employee_id = e.id AND l.state = 'PENDING'),
    'month_approved_cents', (SELECT coalesce(sum(c.amount_cents), 0) FROM public.commission_lines c JOIN public.service_logs l ON l.id = c.service_log_id
                 WHERE v_has_emp AND c.employee_id = e.id AND l.state = 'APPROVED' AND l.service_date >= date_trunc('month', v_today)::date),
    'logged_today', (SELECT count(*) FROM public.service_logs l WHERE l.created_by = p_user AND l.service_date = v_today),
    'last_seen', (SELECT p.last_seen FROM private.user_presence p WHERE p.user_id = p_user));
END $$;

REVOKE ALL ON FUNCTION private.can_view_as(), public.view_as_people(), public.view_as(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.can_view_as(), public.view_as_people(), public.view_as(uuid) TO authenticated;
