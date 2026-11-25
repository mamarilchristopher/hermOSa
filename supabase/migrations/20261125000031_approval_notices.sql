-- update-0031: employees get a notice on Home when management decides something of theirs (CHRIS, Nov 25 2026).
--   * Staff details approved or sent back.
--   * Commission entries signed off: one notice per person per service day with the approved amount
--     ("Your commission amounting to ₱X has been approved and will be included in this cutoff's pay."),
--     kept up to date while unread; an entry not approved gets its own notice with the reason.
-- Schedule swap / day-off requests already notify (update-0022). Safe to run more than once.

CREATE OR REPLACE FUNCTION private.peso(p_cents bigint) RETURNS text LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT '₱' || to_char(coalesce(p_cents, 0) / 100.0, 'FM999,999,990.00')
$$;

-- Staff details decided.
CREATE OR REPLACE FUNCTION private.notice_details_decided() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.user_id IS NOT DISTINCT FROM private.current_user_id() THEN RETURN NEW; END IF; -- an owner approving their own
  INSERT INTO public.notifications (organization_id, user_id, kind, title, body, link, created_by)
  VALUES (NEW.organization_id, NEW.user_id,
    CASE WHEN NEW.state = 'APPROVED' THEN 'DETAILS_APPROVED' ELSE 'DETAILS_RETURNED' END,
    CASE WHEN NEW.state = 'APPROVED' THEN 'Your employee details were approved' ELSE 'Your employee details were sent back' END,
    CASE WHEN NEW.state = 'APPROVED' THEN 'They are now on your employee record. To change something, edit your details and send them again.'
         ELSE left('Please fix this and send again: ' || coalesce(NEW.note, 'see the note on your details page.'), 1000) END,
    '/me/details', private.current_user_id());
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS employee_details_decided_notice ON public.employee_detail_submissions;
CREATE TRIGGER employee_details_decided_notice AFTER UPDATE OF state ON public.employee_detail_submissions
  FOR EACH ROW WHEN (OLD.state = 'PENDING' AND NEW.state IN ('APPROVED', 'RETURNED'))
  EXECUTE FUNCTION private.notice_details_decided();

-- Commission entries signed off (or not).
CREATE OR REPLACE FUNCTION private.notice_service_decided() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c record; v_total bigint; v_link text; v_day text := to_char(NEW.service_date, 'Mon FMDD');
BEGIN
  FOR c IN SELECT DISTINCT cl.employee_id, e.app_user_id FROM public.commission_lines cl JOIN public.employees e ON e.id = cl.employee_id
           WHERE cl.service_log_id = NEW.id AND e.app_user_id IS NOT NULL AND e.app_user_id IS DISTINCT FROM private.current_user_id()
  LOOP
    v_link := '/people/' || c.employee_id || '?month=' || to_char(NEW.service_date, 'YYYY-MM');
    IF NEW.state = 'APPROVED' THEN
      SELECT coalesce(sum(cl.amount_cents), 0) INTO v_total FROM public.commission_lines cl JOIN public.service_logs l ON l.id = cl.service_log_id
      WHERE cl.employee_id = c.employee_id AND l.service_date = NEW.service_date AND l.state = 'APPROVED';
      -- One notice per person per service day: refresh it while it's unread, else start a new one.
      UPDATE public.notifications SET body = left('Your commission amounting to ' || private.peso(v_total) || ' for ' || v_day
          || ' has been approved and will be included in this cutoff''s pay.', 1000), created_at = now(), created_by = private.current_user_id()
      WHERE user_id = c.app_user_id AND kind = 'COMMISSION_APPROVED' AND link = v_link || '&d=' || NEW.service_date AND read_at IS NULL;
      IF NOT FOUND THEN
        INSERT INTO public.notifications (organization_id, user_id, kind, title, body, link, created_by)
        VALUES (NEW.organization_id, c.app_user_id, 'COMMISSION_APPROVED', 'Commission approved',
          left('Your commission amounting to ' || private.peso(v_total) || ' for ' || v_day || ' has been approved and will be included in this cutoff''s pay.', 1000),
          v_link || '&d=' || NEW.service_date, private.current_user_id());
      END IF;
    ELSE
      INSERT INTO public.notifications (organization_id, user_id, kind, title, body, link, created_by)
      VALUES (NEW.organization_id, c.app_user_id, 'COMMISSION_REJECTED', 'A service entry was not approved',
        left(v_day || ': this entry will not earn commission. Reason: ' || coalesce(NEW.decision_note, 'none given'), 1000),
        v_link, private.current_user_id());
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS service_log_decided_notice ON public.service_logs;
CREATE TRIGGER service_log_decided_notice AFTER UPDATE OF state ON public.service_logs
  FOR EACH ROW WHEN (OLD.state = 'PENDING' AND NEW.state IN ('APPROVED', 'REJECTED'))
  EXECUTE FUNCTION private.notice_service_decided();

REVOKE ALL ON FUNCTION private.peso(bigint), private.notice_details_decided(), private.notice_service_decided() FROM PUBLIC, anon, authenticated;
