-- update-0092 (v0.92.0, CHRIS Nov 27): staff are not locked to their home branch.
-- Staff (CMAs, Senior CMAs, Trainees) are moved between branches as needed. Their home branch stays on
-- their records (employees.branch_id, schedule, payroll), but what they do at work follows the branch they are at:
-- a branch-scoped CLINICIAN grant (every CMA, Senior CMA and Trainee) now counts at EVERY open clinic, so they can log services, add photos
-- and waivers, and mark bookings at any branch. Approvals (MANAGER, OWNER) stay as they were.
--
-- Already run? This read-only check tells you (it changes nothing):
--   select case when pg_get_functiondef('private.has_role(text[],uuid)'::regprocedure) like '%update-0092%'
--     then 'ALREADY RUN: tick the box on your To-Do' else 'NOT RUN YET: run the rest of this file' end as result;

CREATE OR REPLACE FUNCTION private.has_role(p_roles text[], p_branch uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  -- update-0092: CLINICIAN grants work at every open clinic, not only the home branch.
  SELECT EXISTS (
    SELECT 1
    FROM public.role_grants g
    JOIN public.app_users u ON u.id = g.user_id
    WHERE u.auth_subject = auth.uid()
      AND u.active
      AND g.revoked_at IS NULL
      AND g.role_code = ANY (p_roles)
      AND (g.branch_id IS NULL OR g.branch_id = p_branch
           OR (g.role_code = 'CLINICIAN' AND p_branch IS NOT NULL
               AND EXISTS (SELECT 1 FROM public.branches b
                           WHERE b.id = p_branch AND b.kind = 'CLINIC' AND b.active
                             AND b.organization_id = (SELECT b2.organization_id FROM public.branches b2 WHERE b2.id = g.branch_id))))
      AND (p_branch IS NOT NULL OR g.branch_id IS NULL)
      AND (g.role_code NOT IN ('OWNER','FINANCE','HR') OR private.has_mfa())
  ) AND private.pin_ok()
$$;

SELECT 'update-0092 is installed' AS result;
