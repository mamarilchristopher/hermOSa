-- update-0081 (CHRIS Nov 26): live Bookings board + Sales follow-ups.
--   * Bookings update live for everyone (Supabase Realtime): a CMA taps Arrived and every open Bookings page shows it,
--     so nobody has to repost the day's list in the group chat.
--   * Every Unresponsive booking lands on Sales follow-ups. The GM (and CSRs, owners) logs each follow-up (call,
--     Facebook, text) with its outcome: still unresponsive, rebooked to a new date, or cancelled. Rebooking moves the
--     booking to its new date as Booked. Each booking keeps its count of follow-ups.

CREATE TABLE IF NOT EXISTS public.booking_followups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  booking_id uuid NOT NULL REFERENCES public.bookings(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('CALL','FACEBOOK','SMS','OTHER')),
  outcome text NOT NULL CHECK (outcome IN ('STILL_UNRESPONSIVE','REBOOKED','CANCELLED')),
  old_date date NOT NULL,
  new_date date,
  note text CHECK (note IS NULL OR length(note) <= 300),
  created_by uuid NOT NULL REFERENCES public.app_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS booking_followups_booking ON public.booking_followups (booking_id, created_at);
CREATE INDEX IF NOT EXISTS booking_followups_day ON public.booking_followups (organization_id, created_at);
ALTER TABLE public.booking_followups ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.booking_followups TO authenticated;
DROP POLICY IF EXISTS booking_followups_read ON public.booking_followups;
CREATE POLICY booking_followups_read ON public.booking_followups FOR SELECT TO authenticated
  USING (organization_id = private.current_org_id() AND private.can_book());

-- Log one follow-up. CSRs, owners and the GM (the people who book).
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
  IF b.status <> 'UNRESPONSIVE' THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_UNRESPONSIVE'); END IF;
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
    UPDATE public.bookings SET status = 'CANCELLED', status_note = coalesce(v_note, status_note),
      status_by = v_user, status_at = now(), updated_at = now() WHERE id = b.id;
  ELSE
    UPDATE public.bookings SET updated_at = now() WHERE id = b.id; -- still unresponsive: wakes the live board
  END IF;
  PERFORM private.audit(b.branch_id, 'BOOKING_FOLLOWUP_' || v_outcome, 'booking', b.id::text, jsonb_build_object('status', b.status, 'date', b.appointment_date), NULL);
  RETURN jsonb_build_object('ok', true);
END $$;
REVOKE ALL ON FUNCTION public.log_booking_followup(uuid, text, text, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.log_booking_followup(uuid, text, text, date, text) TO authenticated;

-- Live updates: Bookings pages refresh by themselves when any booking changes (Realtime applies the read rules above).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'bookings') THEN
      EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.bookings';
    END IF;
  END IF;
END $$;
