-- update-0094 (v0.94.0, CHRIS Nov 27):
--   1. "Ping" on a Late NTE still waiting for an explanation.
--   2. Every booking marked Cancelled needs the client's reason (Bookings and Sales follow-ups).
--
-- 1. Ping.
-- Management taps Ping: the employee gets a reminder in their notifications and on their phone (Hermosapp push).
-- Pings are counted and shown ("Reminded 2 times, last 4:40 PM"); one ping per NTE every 10 minutes.
--
-- Already run? This read-only check tells you (it changes nothing):
--   select case when exists (select 1 from pg_proc where proname = 'ping_nte')
--               and exists (select 1 from information_schema.columns where table_name = 'bookings' and column_name = 'cancel_reason')
--     then 'ALREADY RUN: tick the box on your To-Do' else 'NOT RUN YET: run the rest of this file' end as result;

ALTER TABLE public.late_ntes ADD COLUMN IF NOT EXISTS ping_count integer NOT NULL DEFAULT 0;
ALTER TABLE public.late_ntes ADD COLUMN IF NOT EXISTS last_ping_at timestamptz;
ALTER TABLE public.late_ntes ADD COLUMN IF NOT EXISTS last_ping_by uuid REFERENCES public.app_users(id);

CREATE OR REPLACE FUNCTION public.ping_nte(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE n public.late_ntes%ROWTYPE; v_user uuid := private.current_user_id(); v_to uuid; v_by text;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  SELECT * INTO n FROM public.late_ntes WHERE id = p_id AND organization_id = private.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF NOT private.can_schedule(n.employee_id) OR n.employee_id = private.my_employee_id() THEN RETURN private.deny(n.branch_id, 'late_nte'); END IF;
  IF n.state <> 'OPEN' OR n.ir_id IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_PENDING'); END IF;
  IF n.last_ping_at > now() - interval '10 minutes' THEN RETURN jsonb_build_object('ok', false, 'error', 'PINGED_RECENTLY'); END IF;
  SELECT app_user_id INTO v_to FROM public.employees WHERE id = n.employee_id;
  IF v_to IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NO_APP_ACCOUNT'); END IF;
  v_by := coalesce((SELECT display_name FROM public.app_users WHERE id = v_user), 'Management');
  INSERT INTO public.notifications (organization_id, user_id, kind, title, body, link, created_by)
  VALUES (n.organization_id, v_to, 'NTE_PING', 'Reminder: explain your Late NTE',
    left(format('%s reminds you to explain your Late NTE, %s (%s, %s minutes late). %s', v_by,
      'NTE-' || lpad(n.nte_no::text, 4, '0'), to_char(n.work_date, 'Dy, Mon FMDD'), n.late_minutes,
      CASE WHEN n.respond_by IS NOT NULL AND n.respond_by >= (now() AT TIME ZONE 'Asia/Manila')::date
           THEN 'Explain by the end of ' || to_char(n.respond_by, 'Dy, Mon FMDD') || ', or an IR is issued automatically.'
           ELSE 'Please explain it now.' END), 1000),
    '/nte', v_user);
  UPDATE public.late_ntes SET ping_count = ping_count + 1, last_ping_at = now(), last_ping_by = v_user WHERE id = p_id;
  PERFORM private.audit(n.branch_id, 'NTE_PINGED', 'late_nte', p_id::text, NULL, jsonb_build_object('count', n.ping_count + 1));
  RETURN jsonb_build_object('ok', true, 'count', n.ping_count + 1);
END $$;
REVOKE ALL ON FUNCTION public.ping_nte(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ping_nte(uuid) TO authenticated;

-- 2. Cancelled bookings: the client's reason, required (CHRIS Nov 27). Old cancelled bookings without one show
--    "Client reason needed" on the Bookings page until someone adds it.
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS cancel_reason text CHECK (cancel_reason IS NULL OR length(cancel_reason) <= 300);

-- set_booking_status as in update-0091, plus the reason.
CREATE OR REPLACE FUNCTION public.set_booking_status(p_id uuid, p_status text, p_new_date date, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE b public.bookings%ROWTYPE; v_user uuid := private.current_user_id(); v_today date := (now() AT TIME ZONE 'Asia/Manila')::date;
        v_note text := nullif(left(btrim(coalesce(p_note, '')), 300), '');
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  SELECT * INTO b FROM public.bookings WHERE id = p_id AND organization_id = private.current_org_id() FOR UPDATE;
  IF NOT FOUND OR NOT private.can_see_bookings(b.branch_id) THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF p_status = 'RESCHEDULED' THEN
    IF p_new_date IS NULL OR p_new_date < v_today OR p_new_date > v_today + 365 OR p_new_date = b.appointment_date THEN
      RETURN jsonb_build_object('ok', false, 'error', 'BOOKING_DATE');
    END IF;
    UPDATE public.bookings SET appointment_date = p_new_date, status = 'BOOKED', resched_count = resched_count + 1,
      rescheduled_from = b.appointment_date, status_note = v_note,
      status_by = v_user, status_at = now(), updated_at = now() WHERE id = p_id;
  ELSIF p_status = 'NOTE' THEN
    UPDATE public.bookings SET status_note = v_note, status_by = v_user, status_at = now(), updated_at = now() WHERE id = p_id;
  ELSIF p_status IN ('ARRIVING','ARRIVED','DONE','NO_SHOW','UNRESPONSIVE') THEN
    UPDATE public.bookings SET status = p_status, status_note = coalesce(v_note, status_note),
      status_by = v_user, status_at = now(), updated_at = now() WHERE id = p_id;
  ELSIF p_status = 'CANCEL_REASON' THEN
    -- update-0094: the client's reason for a booking already marked Cancelled (CHRIS Nov 27).
    IF NOT private.can_book() THEN RETURN private.deny(b.branch_id, 'booking'); END IF;
    IF b.status <> 'CANCELLED' THEN RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST'); END IF;
    IF v_note IS NULL OR length(v_note) < 3 THEN RETURN jsonb_build_object('ok', false, 'error', 'CANCEL_REASON_REQUIRED'); END IF;
    UPDATE public.bookings SET cancel_reason = v_note, updated_at = now() WHERE id = p_id;
  ELSIF p_status IN ('BOOKED','CONFIRMED','CANCELLED') THEN
    IF NOT private.can_book() THEN RETURN private.deny(b.branch_id, 'booking'); END IF;
    -- update-0094: every Cancelled booking needs the client's reason (CHRIS Nov 27).
    IF p_status = 'CANCELLED' AND (v_note IS NULL OR length(v_note) < 3) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'CANCEL_REASON_REQUIRED');
    END IF;
    IF p_status = 'CANCELLED' THEN
      UPDATE public.bookings SET status = 'CANCELLED', cancel_reason = v_note, status_by = v_user, status_at = now(), updated_at = now() WHERE id = p_id;
      PERFORM private.audit(b.branch_id, 'BOOKING_CANCELLED', 'booking', p_id::text, jsonb_build_object('status', b.status, 'date', b.appointment_date), jsonb_build_object('reason', v_note));
      RETURN jsonb_build_object('ok', true);
    END IF;
    UPDATE public.bookings SET status = p_status, status_note = coalesce(v_note, status_note),
      status_by = v_user, status_at = now(), updated_at = now() WHERE id = p_id;
  ELSE
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
  END IF;
  PERFORM private.audit(b.branch_id, 'BOOKING_' || p_status, 'booking', p_id::text, jsonb_build_object('status', b.status, 'date', b.appointment_date), NULL);
  RETURN jsonb_build_object('ok', true);
END $$;
REVOKE ALL ON FUNCTION public.set_booking_status(uuid, text, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_booking_status(uuid, text, date, text) TO authenticated;

-- log_booking_followup as in update-0091; "Cancelled" after a follow-up needs the reason too.
CREATE OR REPLACE FUNCTION public.log_booking_followup(p_booking uuid, p_channel text, p_outcome text, p_new_date date, p_note text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  b public.bookings%ROWTYPE; v_user uuid := private.current_user_id(); v_today date := (now() AT TIME ZONE 'Asia/Manila')::date;
  v_note text := nullif(left(btrim(coalesce(p_note, '')), 300), ''); v_channel text := upper(coalesce(p_channel, ''));
  v_outcome text := upper(coalesce(p_outcome, ''));
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT private.can_book() THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_ALLOWED'); END IF;
  IF v_channel NOT IN ('CALL','FACEBOOK','SMS','OTHER') OR v_outcome NOT IN ('STILL_UNRESPONSIVE','REBOOKED','CANCELLED') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
  END IF;
  SELECT * INTO b FROM public.bookings WHERE id = p_booking AND organization_id = private.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF b.status NOT IN ('UNRESPONSIVE','NO_SHOW') THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_UNRESPONSIVE'); END IF;
  IF v_outcome = 'CANCELLED' AND (v_note IS NULL OR length(v_note) < 3) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'CANCEL_REASON_REQUIRED'); -- update-0094
  END IF;
  IF v_outcome = 'REBOOKED' AND (p_new_date IS NULL OR p_new_date < v_today OR p_new_date > v_today + 365) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BOOKING_DATE');
  END IF;

  INSERT INTO public.booking_followups (organization_id, booking_id, channel, outcome, old_date, new_date, note, created_by)
  VALUES (b.organization_id, b.id, v_channel, v_outcome, b.appointment_date, CASE WHEN v_outcome = 'REBOOKED' THEN p_new_date END, v_note, v_user);

  IF v_outcome = 'REBOOKED' THEN
    UPDATE public.bookings SET appointment_date = p_new_date, status = 'BOOKED', resched_count = resched_count + 1,
      rescheduled_from = CASE WHEN p_new_date <> b.appointment_date THEN b.appointment_date ELSE rescheduled_from END,
      status_note = coalesce(v_note, 'Rebooked after follow-up'), status_by = v_user, status_at = now(), updated_at = now()
    WHERE id = b.id;
  ELSIF v_outcome = 'CANCELLED' THEN
    UPDATE public.bookings SET status = 'CANCELLED', cancel_reason = v_note,
      status_by = v_user, status_at = now(), updated_at = now() WHERE id = b.id;
  ELSE
    UPDATE public.bookings SET updated_at = now() WHERE id = b.id; -- still unresponsive: wakes the live board
  END IF;
  PERFORM private.audit(b.branch_id, 'BOOKING_FOLLOWUP_' || v_outcome, 'booking', b.id::text, jsonb_build_object('status', b.status, 'date', b.appointment_date), NULL);
  RETURN jsonb_build_object('ok', true);
END $$;
REVOKE ALL ON FUNCTION public.log_booking_followup(uuid, text, text, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.log_booking_followup(uuid, text, text, date, text) TO authenticated;

SELECT 'update-0094 is installed' AS result;
