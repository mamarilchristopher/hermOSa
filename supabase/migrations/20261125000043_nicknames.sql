-- update-0043: staff nicknames, CMA-only schedule, Test branch off (Hermosa OS v0.43.0).
-- CHRIS: the schedule shows first names or nicknames as supplied; the scheduler is only for CMAs; remove Test and WFH from it.
-- employees.nickname is what the schedule shows; empty = the nickname from their employee details, else the first name.

ALTER TABLE public.employees ADD COLUMN IF NOT EXISTS nickname text CHECK (nickname IS NULL OR length(btrim(nickname)) BETWEEN 1 AND 40);

-- (Setting the current staff's nicknames is in the setup copy only, so no staff names live in the code.)

-- Owners, HR and the person's managers (incl. the GM) set it.
CREATE OR REPLACE FUNCTION public.set_employee_nickname(p_employee uuid, p_nickname text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE e public.employees%ROWTYPE; v_nick text := nullif(btrim(coalesce(p_nickname, '')), '');
BEGIN
  IF private.current_user_id() IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  SELECT * INTO e FROM public.employees WHERE id = p_employee AND organization_id = private.current_org_id();
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF NOT private.has_role(ARRAY['OWNER','HR','MANAGER'], e.branch_id) THEN RETURN private.deny(e.branch_id, 'employee'); END IF;
  IF v_nick IS NOT NULL AND length(v_nick) > 40 THEN RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST'); END IF;
  UPDATE public.employees SET nickname = v_nick WHERE id = p_employee;
  PERFORM private.audit(e.branch_id, 'EMPLOYEE_NICKNAME', 'employee', p_employee::text, jsonb_build_object('nickname', e.nickname), jsonb_build_object('nickname', v_nick));
  RETURN jsonb_build_object('ok', true);
END $$;
REVOKE ALL ON FUNCTION public.set_employee_nickname(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_employee_nickname(uuid, text) TO authenticated;

-- The Test branch is switched off (hidden from the schedule and pickers). History stays.
UPDATE public.branches SET active = false WHERE upper(code) = 'TEST' OR upper(btrim(name)) = 'TEST';

-- Who belongs on the schedule: CMAs, Senior CMAs and Trainees (by position or a clinician role), never CSRs.
CREATE OR REPLACE FUNCTION private.is_cma_employee(p_employee uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.employees e WHERE e.id = p_employee AND e.active
                   AND (coalesce(e.position, '') ~* '(cma|trainee)'
                        OR EXISTS (SELECT 1 FROM public.role_grants g WHERE g.user_id = e.app_user_id AND g.role_code = 'CLINICIAN' AND g.revoked_at IS NULL)))
     AND NOT private.is_csr_employee(p_employee)
$$;
REVOKE ALL ON FUNCTION private.is_cma_employee(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.is_cma_employee(uuid) TO authenticated;

-- week_schedule (from update-0038): CMAs only, and each person's nickname.
CREATE OR REPLACE FUNCTION public.week_schedule(p_monday date) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH me AS (SELECT private.my_employee_id() AS id),
  mine AS (SELECT DISTINCT s.branch_id FROM public.shifts s, me
           WHERE s.employee_id = me.id AND s.work_date BETWEEN p_monday AND p_monday + 6 AND s.state = 'PUBLISHED' AND s.branch_id IS NOT NULL
           UNION SELECT e.branch_id FROM public.employees e, me WHERE e.id = me.id),
  wk AS (
    SELECT s.* FROM public.shifts s, me
    WHERE s.organization_id = private.current_org_id() AND s.work_date BETWEEN p_monday AND p_monday + 6
      AND private.is_cma_employee(s.employee_id)
      AND (private.can_schedule(s.employee_id)
           OR (s.state = 'PUBLISHED' AND (s.employee_id = me.id
               OR EXISTS (SELECT 1 FROM public.shifts x WHERE x.employee_id = s.employee_id AND x.work_date BETWEEN p_monday AND p_monday + 6
                          AND x.state = 'PUBLISHED' AND x.branch_id IN (SELECT branch_id FROM mine)))))
  ), ppl AS (
    SELECT e.id, e.full_name, e.position, e.branch_id, private.can_schedule(e.id) AS can_edit,
           coalesce(nullif(btrim(e.nickname), ''), nullif(btrim((SELECT d.data ->> 'nickname' FROM public.employee_details d WHERE d.employee_id = e.id)), '')) AS nick,
           private.is_csr_employee(e.id) AS csr FROM public.employees e
    WHERE e.organization_id = private.current_org_id() AND e.active AND private.is_cma_employee(e.id)
      AND (private.can_schedule(e.id) OR e.id IN (SELECT employee_id FROM wk) OR e.id = (SELECT id FROM me))
  )
  SELECT jsonb_build_object(
    'me', (SELECT id FROM me),
    'people', coalesce((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'name', p.full_name, 'position', p.position, 'branch_id', p.branch_id,
        'can_edit', p.can_edit, 'csr', p.csr, 'nick', p.nick,
        'pattern', CASE WHEN p.can_edit THEN (SELECT jsonb_build_object('branch_id', sp.branch_id, 'days_off', sp.days_off,
                         'start', to_char(sp.start_time, 'HH24:MI'), 'end', to_char(sp.end_time, 'HH24:MI'))
                         FROM public.schedule_patterns sp WHERE sp.employee_id = p.id) END)
        ORDER BY p.full_name) FROM ppl p), '[]'::jsonb),
    'shifts', coalesce((SELECT jsonb_agg(jsonb_build_object('employee_id', w.employee_id, 'date', w.work_date, 'off', w.is_off,
        'branch_id', w.branch_id, 'start', to_char(w.start_time, 'HH24:MI'), 'end', to_char(w.end_time, 'HH24:MI'),
        'state', w.state, 'note', w.note, 'leave', w.leave_type)) FROM wk w), '[]'::jsonb),
    'requests', coalesce((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'kind', r.kind, 'employee_id', r.employee_id, 'name', e.full_name,
        'date', r.work_date, 'other_employee_id', r.other_employee_id, 'other_name', o.full_name, 'other_date', r.other_date,
        'reason', r.reason, 'mine', r.requested_by = private.current_user_id(), 'coworker_state', r.coworker_state,
        'can_respond', r.kind = 'SWAP' AND r.coworker_state = 'WAITING' AND r.other_employee_id = me.id,
        'can_decide', CASE WHEN r.kind = 'SWAP'
            THEN r.coworker_state = 'ACCEPTED' AND private.swap_approver(r.employee_id, r.other_employee_id)
            ELSE private.can_schedule(r.employee_id) AND r.requested_by <> private.current_user_id() END,
        'created_at', r.created_at) ORDER BY r.created_at)
        FROM public.schedule_requests r JOIN public.employees e ON e.id = r.employee_id
        LEFT JOIN public.employees o ON o.id = r.other_employee_id, me
        WHERE r.organization_id = private.current_org_id() AND r.state = 'PENDING'
          AND (r.requested_by = private.current_user_id() OR r.other_employee_id = me.id OR private.can_schedule(r.employee_id)
               OR private.has_role(ARRAY['OWNER'], NULL) OR private.is_gm())), '[]'::jsonb))
$$;
