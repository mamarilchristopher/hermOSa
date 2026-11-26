-- update-0071 (CHRIS Nov 26): every employee can open Bookings (all branches, read only), so the clinic team can
-- coordinate with the CSRs on who to expect today. Marking a visit stays with the CSRs, owners, the GM and that branch's staff.
-- A rescheduled booking keeps showing on EVERY day it was booked for (not only the last one), with its new date.

-- Anyone in the organization with an active role (staff, CSRs, management).
CREATE OR REPLACE FUNCTION private.can_view_bookings() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.role_grants g JOIN public.app_users u ON u.id = g.user_id
                 WHERE g.user_id = private.current_user_id() AND g.revoked_at IS NULL AND u.organization_id = private.current_org_id())
$$;
REVOKE ALL ON FUNCTION private.can_view_bookings() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.can_view_bookings() TO authenticated;

DROP POLICY IF EXISTS bookings_read ON public.bookings;
CREATE POLICY bookings_read ON public.bookings FOR SELECT TO authenticated
  USING (organization_id = private.current_org_id() AND (private.can_see_bookings(branch_id) OR private.can_view_bookings()));

-- Every day a booking was moved away from (rescheduled_from only remembers the last one).
ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS moved_from date[] NOT NULL DEFAULT '{}';
UPDATE public.bookings SET moved_from = ARRAY[rescheduled_from] WHERE rescheduled_from IS NOT NULL AND moved_from = '{}';
CREATE INDEX IF NOT EXISTS bookings_moved_from ON public.bookings USING gin (moved_from);

CREATE OR REPLACE FUNCTION private.bookings_track_moves() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.appointment_date IS DISTINCT FROM OLD.appointment_date AND NOT (OLD.appointment_date = ANY (NEW.moved_from)) THEN
    NEW.moved_from := array_remove(NEW.moved_from || OLD.appointment_date, NEW.appointment_date);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS bookings_track_moves ON public.bookings;
CREATE TRIGGER bookings_track_moves BEFORE UPDATE OF appointment_date ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION private.bookings_track_moves();
