-- update-0036: day-off swaps between staff need the coworker's OK and an owner's approval (CHRIS, Nov 25 2026). Safe to run more than once.
-- * Staff ask to swap a day, or trade days off, with a coworker on the published schedule.
-- * The coworker accepts or declines first. Only after they accept can an owner or the General Manager approve.
-- * On approval both people's schedules change by themselves and both get a notice. Days on leave can't be swapped.
-- * Moving your own day off (no coworker) works as before.

ALTER TABLE public.schedule_requests ADD COLUMN IF NOT EXISTS coworker_state text;
ALTER TABLE public.schedule_requests ADD COLUMN IF NOT EXISTS coworker_at timestamptz;
ALTER TABLE public.schedule_requests ADD COLUMN IF NOT EXISTS coworker_note text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'schedule_requests_coworker_state_check') THEN
    ALTER TABLE public.schedule_requests ADD CONSTRAINT schedule_requests_coworker_state_check
      CHECK (coworker_state IS NULL OR coworker_state IN ('WAITING','ACCEPTED','DECLINED'));
  END IF;
END $$;
-- Swaps already waiting now need the coworker's OK too.
UPDATE public.schedule_requests SET coworker_state = 'WAITING' WHERE kind = 'SWAP' AND state = 'PENDING' AND coworker_state IS NULL;

-- Who approves a swap: an owner, or the GM when the GM isn't one of the two people swapping.
CREATE OR REPLACE FUNCTION private.swap_approver(p_a uuid, p_b uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT private.has_role(ARRAY['OWNER'], NULL)
      OR (private.is_gm() AND private.my_employee_id() IS DISTINCT FROM p_a AND private.my_employee_id() IS DISTINCT FROM p_b)
$$;
REVOKE ALL ON FUNCTION private.swap_approver(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.swap_approver(uuid, uuid) TO authenticated;

-- One day of a swap must be on both published schedules, different, and not leave.
CREATE OR REPLACE FUNCTION private.swap_day_ok(p_a uuid, p_b uuid, p_date date) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.shifts%ROWTYPE; b public.shifts%ROWTYPE;
BEGIN
  SELECT * INTO a FROM public.shifts WHERE employee_id = p_a AND work_date = p_date AND state = 'PUBLISHED';
  IF NOT FOUND THEN RETURN 'NOT_SCHEDULED'; END IF;
  SELECT * INTO b FROM public.shifts WHERE employee_id = p_b AND work_date = p_date AND state = 'PUBLISHED';
  IF NOT FOUND THEN RETURN 'NOT_SCHEDULED'; END IF;
  IF a.leave_type IS NOT NULL OR b.leave_type IS NOT NULL THEN RETURN 'ON_LEAVE'; END IF;
  IF (a.is_off, a.branch_id, a.start_time, a.end_time) IS NOT DISTINCT FROM (b.is_off, b.branch_id, b.start_time, b.end_time) THEN
    RETURN 'SAME_SHIFT';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION private.swap_day_ok(uuid, uuid, date) FROM PUBLIC, anon;

CREATE OR REPLACE FUNCTION private.day_list(p_date date, p_other date) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT to_char(p_date, 'Dy, Mon FMDD') || CASE WHEN p_other IS NOT NULL THEN ' and ' || to_char(p_other, 'Dy, Mon FMDD') ELSE '' END
$$;

-- Staff: swap a day (or trade days off: two days) with a coworker, or move their own day off.
CREATE OR REPLACE FUNCTION public.request_schedule_change(p_kind text, p_date date, p_other_employee uuid, p_other_date date, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_me uuid := private.my_employee_id(); a public.shifts%ROWTYPE; b public.shifts%ROWTYPE; v_id uuid; v_err text;
        v_today date := (now() AT TIME ZONE 'Asia/Manila')::date; v_name text; v_week text;
BEGIN
  IF private.current_user_id() IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF v_me IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NO_EMPLOYEE_RECORD'); END IF;
  IF p_date IS NULL OR p_date < v_today THEN RETURN jsonb_build_object('ok', false, 'error', 'INVALID_DATE'); END IF;
  SELECT * INTO a FROM public.shifts WHERE employee_id = v_me AND work_date = p_date AND state = 'PUBLISHED';
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_SCHEDULED'); END IF;
  SELECT full_name INTO v_name FROM public.employees WHERE id = v_me;
  v_week := '/schedule?week=' || to_char(date_trunc('week', p_date), 'YYYY-MM-DD');
  IF upper(p_kind) = 'SWAP' THEN
    IF p_other_employee IS NULL OR p_other_employee = v_me
       OR NOT EXISTS (SELECT 1 FROM public.employees WHERE id = p_other_employee AND organization_id = private.current_org_id() AND active) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
    END IF;
    IF p_other_date IS NOT NULL AND (p_other_date = p_date OR p_other_date < v_today) THEN RETURN jsonb_build_object('ok', false, 'error', 'INVALID_DATE'); END IF;
    v_err := private.swap_day_ok(v_me, p_other_employee, p_date);
    IF v_err IS NULL AND p_other_date IS NOT NULL THEN v_err := private.swap_day_ok(v_me, p_other_employee, p_other_date); END IF;
    IF v_err IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'error', v_err); END IF;
    IF EXISTS (SELECT 1 FROM public.schedule_requests WHERE state = 'PENDING' AND kind = 'SWAP'
               AND (employee_id IN (v_me, p_other_employee) OR other_employee_id IN (v_me, p_other_employee))
               AND (work_date IN (p_date, p_other_date) OR other_date IN (p_date, p_other_date))) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'SWAP_ALREADY_ASKED');
    END IF;
  ELSIF upper(p_kind) = 'DAY_OFF' THEN
    IF NOT a.is_off THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_A_DAY_OFF'); END IF;
    IF p_other_date IS NULL OR p_other_date = p_date OR p_other_date < v_today THEN
      RETURN jsonb_build_object('ok', false, 'error', 'INVALID_DATE');
    END IF;
    SELECT * INTO b FROM public.shifts WHERE employee_id = v_me AND work_date = p_other_date AND state = 'PUBLISHED' AND NOT is_off;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_SCHEDULED'); END IF;
    p_other_employee := NULL;
  ELSE
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
  END IF;
  INSERT INTO public.schedule_requests (organization_id, kind, employee_id, work_date, other_employee_id, other_date, reason, requested_by, coworker_state)
  VALUES (private.current_org_id(), upper(p_kind), v_me, p_date, p_other_employee, p_other_date,
          nullif(left(btrim(coalesce(p_reason, '')), 300), ''), private.current_user_id(), CASE WHEN upper(p_kind) = 'SWAP' THEN 'WAITING' END)
  RETURNING id INTO v_id;
  IF upper(p_kind) = 'SWAP' THEN
    -- The coworker answers first; owners and the GM hear about it once they accept.
    PERFORM private.notify_employee(p_other_employee, 'SWAP_ASKED', 'Swap request: please accept or decline',
      left(coalesce(v_name, 'Someone') || ' asked to swap ' || private.day_list(p_date, p_other_date) || ' with you'
           || coalesce(': ' || nullif(btrim(coalesce(p_reason, '')), ''), '') || '. Open the schedule to accept or decline.', 1000), v_week);
  ELSE
    PERFORM private.notify_management(a.branch_id, 'SCHEDULE_REQUEST', 'Schedule change request',
      coalesce(v_name, 'Someone') || ': work ' || to_char(p_date, 'Dy, Mon FMDD') || ' and take ' || to_char(p_other_date, 'Dy, Mon FMDD') || ' off.', v_week);
  END IF;
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'state', 'PENDING');
END $$;

-- The coworker accepts (then owners and the GM are asked) or declines (the request ends).
CREATE OR REPLACE FUNCTION public.respond_schedule_swap(p_id uuid, p_accept boolean, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE q public.schedule_requests%ROWTYPE; v_me uuid := private.my_employee_id(); v_user uuid := private.current_user_id();
        v_a text; v_b text; v_week text;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  SELECT * INTO q FROM public.schedule_requests WHERE id = p_id AND organization_id = private.current_org_id() FOR UPDATE;
  IF NOT FOUND OR q.kind <> 'SWAP' OR q.other_employee_id IS DISTINCT FROM v_me THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF q.state <> 'PENDING' OR q.coworker_state <> 'WAITING' THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_PENDING'); END IF;
  SELECT full_name INTO v_a FROM public.employees WHERE id = q.employee_id;
  SELECT full_name INTO v_b FROM public.employees WHERE id = v_me;
  v_week := '/schedule?week=' || to_char(date_trunc('week', q.work_date), 'YYYY-MM-DD');
  IF coalesce(p_accept, false) THEN
    UPDATE public.schedule_requests SET coworker_state = 'ACCEPTED', coworker_at = now(),
      coworker_note = nullif(left(btrim(coalesce(p_note, '')), 300), '') WHERE id = p_id;
    INSERT INTO public.notifications (organization_id, user_id, kind, title, body, link, created_by)
    SELECT DISTINCT q.organization_id, g.user_id, 'SWAP_TO_APPROVE', 'Swap to approve',
      left(v_a || ' and ' || v_b || ' agreed to swap ' || private.day_list(q.work_date, q.other_date) || '. Your approval is needed.', 1000), v_week, v_user
    FROM public.role_grants g JOIN public.app_users u ON u.id = g.user_id AND u.active
    WHERE g.revoked_at IS NULL AND u.organization_id = q.organization_id AND g.user_id <> v_user
      AND (g.role_code = 'OWNER' OR (g.role_code = 'MANAGER' AND g.branch_id IS NULL));
    PERFORM private.notify_employee(q.employee_id, 'SWAP_ACCEPTED', v_b || ' accepted your swap',
      private.day_list(q.work_date, q.other_date) || ': now waiting for an owner''s approval.', v_week);
  ELSE
    UPDATE public.schedule_requests SET coworker_state = 'DECLINED', coworker_at = now(), state = 'REJECTED',
      coworker_note = nullif(left(btrim(coalesce(p_note, '')), 300), '') WHERE id = p_id;
    PERFORM private.notify_employee(q.employee_id, 'SWAP_DECLINED', v_b || ' declined your swap',
      left(private.day_list(q.work_date, q.other_date) || coalesce(': ' || nullif(btrim(coalesce(p_note, '')), ''), '') || '.', 1000), v_week);
  END IF;
  PERFORM private.audit(NULL, CASE WHEN p_accept THEN 'SWAP_ACCEPTED' ELSE 'SWAP_DECLINED' END, 'schedule_request', p_id::text, NULL, NULL);
  RETURN jsonb_build_object('ok', true);
END $$;

-- Swaps: an owner or the GM, after the coworker accepted. Day-off moves: a manager, as before.
CREATE OR REPLACE FUNCTION public.decide_schedule_request(p_id uuid, p_approve boolean, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE q public.schedule_requests%ROWTYPE; a public.shifts%ROWTYPE; b public.shifts%ROWTYPE; v_user uuid := private.current_user_id();
        d date; v_week text; v_err text;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  SELECT * INTO q FROM public.schedule_requests WHERE id = p_id AND organization_id = private.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF q.kind = 'SWAP' THEN
    IF NOT private.swap_approver(q.employee_id, q.other_employee_id) THEN RETURN private.deny(NULL, 'schedule.decide'); END IF;
  ELSE
    IF NOT private.can_schedule(q.employee_id) THEN RETURN private.deny(NULL, 'schedule.decide'); END IF;
    IF q.requested_by = v_user THEN RETURN private.deny(NULL, 'schedule.decide', 'SELF_APPROVAL_DENIED'); END IF;
  END IF;
  IF q.state <> 'PENDING' THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_PENDING'); END IF;
  v_week := '/schedule?week=' || to_char(date_trunc('week', q.work_date), 'YYYY-MM-DD');
  IF NOT coalesce(p_approve, false) THEN
    IF length(btrim(coalesce(p_note, ''))) < 3 THEN RETURN jsonb_build_object('ok', false, 'error', 'REASON_REQUIRED'); END IF;
    UPDATE public.schedule_requests SET state = 'REJECTED', decided_by = v_user, decided_at = now(), decision_note = left(btrim(p_note), 300) WHERE id = p_id;
    PERFORM private.notify_employee(q.employee_id, 'SCHEDULE_REQUEST', 'Schedule request not approved', left(btrim(p_note), 300), v_week);
    IF q.kind = 'SWAP' THEN
      PERFORM private.notify_employee(q.other_employee_id, 'SCHEDULE_REQUEST', 'Swap not approved', left(btrim(p_note), 300), v_week);
    END IF;
    RETURN jsonb_build_object('ok', true, 'state', 'REJECTED');
  END IF;
  IF q.kind = 'SWAP' THEN
    IF q.coworker_state IS DISTINCT FROM 'ACCEPTED' THEN RETURN jsonb_build_object('ok', false, 'error', 'COWORKER_PENDING'); END IF;
    FOR d IN SELECT x FROM unnest(ARRAY[q.work_date, q.other_date]) x WHERE x IS NOT NULL LOOP
      v_err := private.swap_day_ok(q.employee_id, q.other_employee_id, d);
      IF v_err IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'SCHEDULE_CHANGED_SINCE'); END IF;
    END LOOP;
    FOR d IN SELECT x FROM unnest(ARRAY[q.work_date, q.other_date]) x WHERE x IS NOT NULL LOOP
      SELECT * INTO a FROM public.shifts WHERE employee_id = q.employee_id AND work_date = d FOR UPDATE;
      SELECT * INTO b FROM public.shifts WHERE employee_id = q.other_employee_id AND work_date = d FOR UPDATE;
      UPDATE public.shifts SET is_off = b.is_off, branch_id = b.branch_id, start_time = b.start_time, end_time = b.end_time,
        note = 'Swapped', updated_by = v_user, updated_at = now() WHERE id = a.id;
      UPDATE public.shifts SET is_off = a.is_off, branch_id = a.branch_id, start_time = a.start_time, end_time = a.end_time,
        note = 'Swapped', updated_by = v_user, updated_at = now() WHERE id = b.id;
    END LOOP;
    PERFORM private.notify_employee(q.other_employee_id, 'SCHEDULE_CHANGED', 'Swap approved',
      private.day_list(q.work_date, q.other_date) || ': your schedule was swapped.', v_week);
  ELSE
    SELECT * INTO a FROM public.shifts WHERE employee_id = q.employee_id AND work_date = q.work_date FOR UPDATE;
    SELECT * INTO b FROM public.shifts WHERE employee_id = q.employee_id AND work_date = q.other_date FOR UPDATE;
    IF a.id IS NULL OR b.id IS NULL OR NOT a.is_off OR b.is_off THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_SCHEDULED'); END IF;
    UPDATE public.shifts SET is_off = false, branch_id = b.branch_id, start_time = b.start_time, end_time = b.end_time,
      note = 'Day off moved', updated_by = v_user, updated_at = now() WHERE id = a.id;
    UPDATE public.shifts SET is_off = true, branch_id = NULL, start_time = NULL, end_time = NULL,
      note = 'Day off moved', updated_by = v_user, updated_at = now() WHERE id = b.id;
  END IF;
  UPDATE public.schedule_requests SET state = 'APPROVED', decided_by = v_user, decided_at = now(),
    decision_note = nullif(left(btrim(coalesce(p_note, '')), 300), '') WHERE id = p_id;
  PERFORM private.notify_employee(q.employee_id, 'SCHEDULE_CHANGED', 'Schedule request approved',
    CASE WHEN q.kind = 'SWAP' THEN private.day_list(q.work_date, q.other_date) || ' swapped.'
         ELSE to_char(q.work_date, 'Dy, Mon FMDD') || ' is now a work day; ' || to_char(q.other_date, 'Dy, Mon FMDD') || ' is your day off.' END,
    v_week);
  PERFORM private.audit(NULL, 'SCHEDULE_REQUEST_APPROVED', 'schedule_request', p_id::text, NULL, NULL);
  RETURN jsonb_build_object('ok', true, 'state', 'APPROVED');
END $$;

-- The asker can withdraw until it's decided (before or after the coworker answers).
CREATE OR REPLACE FUNCTION public.cancel_schedule_request(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE q public.schedule_requests%ROWTYPE;
BEGIN
  UPDATE public.schedule_requests SET state = 'CANCELLED' WHERE id = p_id AND requested_by = private.current_user_id() AND state = 'PENDING'
  RETURNING * INTO q;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF q.kind = 'SWAP' AND q.coworker_state = 'ACCEPTED' THEN
    PERFORM private.notify_employee(q.other_employee_id, 'SCHEDULE_REQUEST', 'Swap withdrawn',
      private.day_list(q.work_date, q.other_date) || ': the swap was withdrawn. Your schedule stays as it was.',
      '/schedule?week=' || to_char(date_trunc('week', q.work_date), 'YYYY-MM-DD'));
  END IF;
  RETURN jsonb_build_object('ok', true);
END $$;

-- Staff can see coworkers' requests: unchanged. Owners and the GM now see every pending swap (they approve them).
CREATE OR REPLACE FUNCTION public.week_schedule(p_monday date) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH me AS (SELECT private.my_employee_id() AS id),
  mine AS (SELECT DISTINCT s.branch_id FROM public.shifts s, me
           WHERE s.employee_id = me.id AND s.work_date BETWEEN p_monday AND p_monday + 6 AND s.state = 'PUBLISHED' AND s.branch_id IS NOT NULL
           UNION SELECT e.branch_id FROM public.employees e, me WHERE e.id = me.id),
  wk AS (
    SELECT s.* FROM public.shifts s, me
    WHERE s.organization_id = private.current_org_id() AND s.work_date BETWEEN p_monday AND p_monday + 6
      AND (private.can_schedule(s.employee_id)
           OR (s.state = 'PUBLISHED' AND (s.employee_id = me.id
               OR EXISTS (SELECT 1 FROM public.shifts x WHERE x.employee_id = s.employee_id AND x.work_date BETWEEN p_monday AND p_monday + 6
                          AND x.state = 'PUBLISHED' AND x.branch_id IN (SELECT branch_id FROM mine)))))
  ), ppl AS (
    SELECT e.id, e.full_name, e.position, e.branch_id, private.can_schedule(e.id) AS can_edit FROM public.employees e
    WHERE e.organization_id = private.current_org_id() AND e.active
      AND (private.can_schedule(e.id) OR e.id IN (SELECT employee_id FROM wk) OR e.id = (SELECT id FROM me))
  )
  SELECT jsonb_build_object(
    'me', (SELECT id FROM me),
    'people', coalesce((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'name', p.full_name, 'position', p.position, 'branch_id', p.branch_id,
        'can_edit', p.can_edit,
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

REVOKE ALL ON FUNCTION public.respond_schedule_swap(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.respond_schedule_swap(uuid, boolean, text) TO authenticated;
