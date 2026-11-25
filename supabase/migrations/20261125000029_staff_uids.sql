-- update-0029: a short UID on every staff record (ST-0001) and every login account (AC-0001), CHRIS Nov 25 2026.
-- Shown on every staff page so invalid or duplicate records can be named and cleaned up.
-- Numbers follow the order records were created and are never reused.

CREATE SEQUENCE IF NOT EXISTS public.employee_uid_seq;
CREATE SEQUENCE IF NOT EXISTS public.app_user_uid_seq;
ALTER TABLE public.employees ADD COLUMN IF NOT EXISTS uid text;
ALTER TABLE public.app_users ADD COLUMN IF NOT EXISTS uid text;

-- Existing records, oldest first.
WITH base AS (SELECT coalesce(max(substr(uid, 4)::integer), 0) AS m FROM public.employees WHERE uid ~ '^ST-[0-9]+$'),
o AS (SELECT id, row_number() OVER (ORDER BY created_at, id) AS n FROM public.employees WHERE uid IS NULL)
UPDATE public.employees e SET uid = 'ST-' || lpad((base.m + o.n)::text, 4, '0') FROM o, base WHERE e.id = o.id;
WITH base AS (SELECT coalesce(max(substr(uid, 4)::integer), 0) AS m FROM public.app_users WHERE uid ~ '^AC-[0-9]+$'),
o AS (SELECT id, row_number() OVER (ORDER BY created_at, id) AS n FROM public.app_users WHERE uid IS NULL)
UPDATE public.app_users u SET uid = 'AC-' || lpad((base.m + o.n)::text, 4, '0') FROM o, base WHERE u.id = o.id;

SELECT setval('public.employee_uid_seq', greatest(1, (SELECT coalesce(max(substr(uid, 4)::integer), 0) FROM public.employees WHERE uid ~ '^ST-[0-9]+$')),
  (SELECT count(*) > 0 FROM public.employees));
SELECT setval('public.app_user_uid_seq', greatest(1, (SELECT coalesce(max(substr(uid, 4)::integer), 0) FROM public.app_users WHERE uid ~ '^AC-[0-9]+$')),
  (SELECT count(*) > 0 FROM public.app_users));

-- New records get the next number automatically.
ALTER TABLE public.employees ALTER COLUMN uid SET DEFAULT 'ST-' || lpad(nextval('public.employee_uid_seq')::text, 4, '0');
ALTER TABLE public.app_users ALTER COLUMN uid SET DEFAULT 'AC-' || lpad(nextval('public.app_user_uid_seq')::text, 4, '0');
ALTER TABLE public.employees ALTER COLUMN uid SET NOT NULL;
ALTER TABLE public.app_users ALTER COLUMN uid SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS employees_uid_unique ON public.employees (uid);
CREATE UNIQUE INDEX IF NOT EXISTS app_users_uid_unique ON public.app_users (uid);
GRANT USAGE ON SEQUENCE public.employee_uid_seq, public.app_user_uid_seq TO authenticated, service_role;

-- On Duty and attendance lists also carry the staff UID (same as update-0024 / update-0022 plus 'uid').
CREATE OR REPLACE FUNCTION public.on_duty(p_date date) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH people AS (
    SELECT s.employee_id, s.branch_id, s.start_time, s.end_time, s.is_off, s.note, s.leave_type FROM public.shifts s
    WHERE s.organization_id = private.current_org_id() AND s.work_date = p_date AND s.state = 'PUBLISHED'
    UNION
    SELECT DISTINCT ON (t.employee_id) t.employee_id, t.branch_id, NULL::time, NULL::time, false, 'Not on the schedule', NULL::text
    FROM public.time_punches t
    WHERE t.organization_id = private.current_org_id() AND t.work_date = p_date
      AND NOT EXISTS (SELECT 1 FROM public.shifts s WHERE s.employee_id = t.employee_id AND s.work_date = p_date AND s.state = 'PUBLISHED' AND NOT s.is_off)
    ORDER BY 1
  ), grace AS (SELECT late_grace_minutes AS g FROM public.organizations WHERE id = private.current_org_id())
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'employee_id', p.employee_id, 'name', e.full_name, 'uid', e.uid, 'position', e.position, 'branch_id', p.branch_id,
      'off', p.is_off, 'leave', p.leave_type, 'start', p.start_time, 'end', p.end_time, 'note', p.note,
      'time_in', i.punched_at, 'time_out', o.punched_at, 'in_photo', i.photo_path, 'in_distance_m', i.distance_m,
      'late_min', CASE WHEN p.start_time IS NOT NULL AND i.punched_at IS NOT NULL
                       THEN greatest(0, floor(extract(epoch FROM ((i.punched_at AT TIME ZONE 'Asia/Manila') - (p_date + p.start_time))) / 60)::int
                                       - (SELECT g FROM grace)) END)
    ORDER BY p.is_off, e.full_name), '[]'::jsonb)
  FROM people p JOIN public.employees e ON e.id = p.employee_id
  LEFT JOIN LATERAL (SELECT t.punched_at, t.photo_path, t.distance_m FROM public.time_punches t WHERE t.employee_id = p.employee_id AND t.work_date = p_date AND t.kind = 'IN' ORDER BY t.punched_at LIMIT 1) i ON true
  LEFT JOIN LATERAL (SELECT t.punched_at FROM public.time_punches t WHERE t.employee_id = p.employee_id AND t.work_date = p_date AND t.kind = 'OUT' ORDER BY t.punched_at DESC LIMIT 1) o ON true
  WHERE private.can_schedule(p.employee_id)
$$;
CREATE OR REPLACE FUNCTION public.attendance(p_start date, p_end date) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce(jsonb_agg(x ORDER BY x ->> 'name'), '[]'::jsonb) FROM (
    SELECT jsonb_build_object('employee_id', e.id, 'name', e.full_name, 'uid', e.uid,
      'scheduled', count(*) FILTER (WHERE NOT s.is_off),
      'present', count(i.punched_at) FILTER (WHERE NOT s.is_off),
      'absent', count(*) FILTER (WHERE NOT s.is_off AND i.punched_at IS NULL AND s.work_date < (now() AT TIME ZONE 'Asia/Manila')::date),
      'late_days', count(*) FILTER (WHERE NOT s.is_off AND (i.punched_at AT TIME ZONE 'Asia/Manila') > s.work_date + s.start_time
                                       + make_interval(mins => (SELECT late_grace_minutes FROM public.organizations WHERE id = private.current_org_id()))),
      'late_min', coalesce(sum(greatest(0, floor(extract(epoch FROM ((i.punched_at AT TIME ZONE 'Asia/Manila') - (s.work_date + s.start_time))) / 60)::int
                       - (SELECT late_grace_minutes FROM public.organizations WHERE id = private.current_org_id()))) FILTER (WHERE NOT s.is_off), 0)) AS x
    FROM public.shifts s JOIN public.employees e ON e.id = s.employee_id
    LEFT JOIN LATERAL (SELECT t.punched_at FROM public.time_punches t WHERE t.employee_id = s.employee_id AND t.work_date = s.work_date AND t.kind = 'IN'
                       ORDER BY t.punched_at LIMIT 1) i ON true
    WHERE s.organization_id = private.current_org_id() AND s.state = 'PUBLISHED' AND s.work_date BETWEEN p_start AND p_end
      AND p_end - p_start <= 62 AND private.can_schedule(s.employee_id)
    GROUP BY e.id, e.full_name, e.uid) y
$$;

SELECT 'update-0029 is installed' AS result,
  (SELECT count(*) FROM public.employees) AS staff_records_with_uid,
  (SELECT count(*) FROM public.app_users) AS accounts_with_uid;
