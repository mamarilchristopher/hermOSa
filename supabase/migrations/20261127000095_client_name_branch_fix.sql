-- update-0095 (v0.95.0, CHRIS Nov 27, from Geraldine's Nov 25-26 commission log list):
--   1. Fix a client's name on past Service log entries (a misspelled name), on one entry or on all of that client's entries.
--   2. Owners and the GM move an entry to the right branch (e.g. the wrong branch was picked).
--   3. Double dose on a package (e.g. VContour, Lemon Bottle): CHRIS chose "uses 2 package sessions". The visit's
--      session N is logged as usual and session N+1 is added as its own line (₱0, same people, usual session commission).
--
-- Already run? This read-only check tells you (it changes nothing):
--   select case when exists (select 1 from pg_proc where proname = 'log_double_dose')
--     then 'ALREADY RUN: tick the box on your To-Do' else 'NOT RUN YET: run the rest of this file' end as result;

-- The guard of update-0091, plus the branch move.
CREATE OR REPLACE FUNCTION public.guard_service_logs() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('hermosa.log_delete', true) = 'on' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'SERVICE_LOGS_ARE_NOT_DELETED';
  END IF;
  -- update-0091: linking an entry to its booking may change only the booking link and the client name (waiver name).
  IF current_setting('hermosa.booking_link', true) = 'on'
     AND (to_jsonb(NEW) - 'booking_id' - 'client_name') = (to_jsonb(OLD) - 'booking_id' - 'client_name') THEN RETURN NEW; END IF;
  -- update-0085: marking a Hiko balance paid after a DP may change only the DP flag, the effective rate and the price note.
  IF current_setting('hermosa.after_dp', true) = 'on'
     AND (to_jsonb(NEW) - 'after_dp' - 'rate_bp' - 'price_note') = (to_jsonb(OLD) - 'after_dp' - 'rate_bp' - 'price_note') THEN RETURN NEW; END IF;
  -- update-0079: re-numbering may change the entry number only.
  IF current_setting('hermosa.log_renumber', true) = 'on'
     AND (to_jsonb(NEW) - 'log_no') = (to_jsonb(OLD) - 'log_no') THEN RETURN NEW; END IF;
  -- update-0095: change_service_branch may move the branch only.
  IF current_setting('hermosa.log_rebranch', true) = 'on'
     AND (to_jsonb(NEW) - 'branch_id') = (to_jsonb(OLD) - 'branch_id') THEN RETURN NEW; END IF;
  -- update-0073: change_service_date may move the date only.
  IF current_setting('hermosa.log_redate', true) = 'on'
     AND (to_jsonb(NEW) - 'service_date') = (to_jsonb(OLD) - 'service_date') THEN RETURN NEW; END IF;
  IF current_setting('hermosa.photo_sharing', true) = 'on'
     AND (to_jsonb(NEW) - 'share_ok' - 'photos_due' - 'photo_folder') = (to_jsonb(OLD) - 'share_ok' - 'photos_due' - 'photo_folder') THEN RETURN NEW; END IF;
  IF OLD.state <> 'PENDING' THEN RAISE EXCEPTION 'SERVICE_LOG_ALREADY_DECIDED'; END IF;
  IF (NEW.branch_id, NEW.service_date, NEW.service_id, NEW.amount_paid_cents, NEW.commission_type, NEW.performer_id,
      NEW.assistant_id, NEW.rate_bp, NEW.lead_share_bp, NEW.created_by, NEW.receipt_no)
     IS DISTINCT FROM (OLD.branch_id, OLD.service_date, OLD.service_id, OLD.amount_paid_cents, OLD.commission_type,
      OLD.performer_id, OLD.assistant_id, OLD.rate_bp, OLD.lead_share_bp, OLD.created_by, OLD.receipt_no)
     OR (NEW.visit_kind IS DISTINCT FROM OLD.visit_kind AND OLD.visit_kind <> 'PAID') THEN
    RAISE EXCEPTION 'SERVICE_LOG_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;

-- 1. Client name. The entry's own staff (who entered it, did it or assisted) or management fix one entry;
--    management can also fix every entry with the same (misspelled) name at once.
CREATE OR REPLACE FUNCTION public.rename_service_client(p_log uuid, p_name text, p_all boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id(); l public.service_logs%ROWTYPE; v_name text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  v_mgmt boolean := private.is_management(private.current_user_id()); v_n integer := 0; x record;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  SELECT * INTO l FROM public.service_logs WHERE id = p_log AND organization_id = private.current_org_id();
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF NOT (v_mgmt OR l.created_by = v_user
          OR EXISTS (SELECT 1 FROM public.employees e WHERE e.id IN (l.performer_id, l.assistant_id) AND e.app_user_id = v_user)) THEN
    RETURN private.deny(l.branch_id, 'service_log');
  END IF;
  IF length(v_name) < 2 OR length(v_name) > 120 THEN RETURN jsonb_build_object('ok', false, 'error', 'CLIENT_NAME_REQUIRED'); END IF;
  IF coalesce(p_all, false) AND NOT v_mgmt THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_ALLOWED'); END IF;
  PERFORM set_config('hermosa.booking_link', 'on', true); -- the guard lets this change the client name only
  FOR x IN SELECT id, branch_id, client_name FROM public.service_logs
            WHERE organization_id = l.organization_id
              AND (id = l.id OR (coalesce(p_all, false) AND l.client_name IS NOT NULL
                                 AND lower(btrim(client_name)) = lower(btrim(l.client_name))))
              AND client_name IS DISTINCT FROM v_name
  LOOP
    UPDATE public.service_logs SET client_name = v_name WHERE id = x.id;
    PERFORM private.audit(x.branch_id, 'SERVICE_LOG_CLIENT_RENAMED', 'service_log', x.id::text,
      jsonb_build_object('client', x.client_name), jsonb_build_object('client', v_name));
    v_n := v_n + 1;
  END LOOP;
  PERFORM set_config('hermosa.booking_link', 'off', true);
  RETURN jsonb_build_object('ok', true, 'changed', v_n);
END $$;
REVOKE ALL ON FUNCTION public.rename_service_client(uuid, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rename_service_client(uuid, text, boolean) TO authenticated;

-- 2. Branch. Owners and the GM only; not once its commission is on a final payslip. Photos follow the entry.
CREATE OR REPLACE FUNCTION public.change_service_branch(p_log uuid, p_branch uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE l public.service_logs%ROWTYPE; v_user uuid := private.current_user_id();
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  SELECT * INTO l FROM public.service_logs WHERE id = p_log AND organization_id = private.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF NOT (private.has_role(ARRAY['OWNER'], NULL) OR private.is_gm()) THEN RETURN private.deny(l.branch_id, 'service_log'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches b WHERE b.id = p_branch AND b.organization_id = l.organization_id AND b.kind = 'CLINIC' AND b.active) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
  END IF;
  IF p_branch = l.branch_id THEN RETURN jsonb_build_object('ok', true, 'id', l.id); END IF;
  IF EXISTS (SELECT 1 FROM public.commission_paid cp JOIN public.commission_lines c ON c.id = cp.commission_line_id WHERE c.service_log_id = l.id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ALREADY_PAID');
  END IF;
  PERFORM set_config('hermosa.log_rebranch', 'on', true);
  UPDATE public.service_logs SET branch_id = p_branch WHERE id = l.id;
  PERFORM set_config('hermosa.log_rebranch', 'off', true);
  UPDATE public.service_photos SET branch_id = p_branch WHERE service_log_id = l.id;
  PERFORM private.audit(p_branch, 'SERVICE_LOG_REBRANCHED', 'service_log', l.id::text,
    jsonb_build_object('branch', l.branch_id), jsonb_build_object('branch', p_branch));
  RETURN jsonb_build_object('ok', true, 'id', l.id);
END $$;
REVOKE ALL ON FUNCTION public.change_service_branch(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.change_service_branch(uuid, uuid) TO authenticated;

-- 3. Double dose. p_log = the session just saved; adds the next session of the same package to the same visit.
CREATE OR REPLACE FUNCTION public.log_double_dose(p_log uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid := private.current_user_id(); l record; v_n integer; r jsonb; v_id uuid; v_type text;
  v_mgmt boolean := private.is_management(private.current_user_id());
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  SELECT * INTO l FROM public.service_logs WHERE id = p_log AND organization_id = private.current_org_id();
  IF NOT FOUND OR l.state = 'REJECTED' THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF l.created_by <> v_user AND NOT v_mgmt THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_ALLOWED'); END IF;
  IF coalesce(l.visit_kind, 'PAID') <> 'PAID' THEN RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST'); END IF;
  SELECT jsonb_array_length(to_jsonb(s) -> 'session_prices') INTO v_n FROM public.services s
   WHERE s.id = l.service_id AND jsonb_typeof(to_jsonb(s) -> 'session_prices') = 'array';
  IF v_n IS NULL OR v_n = 0 THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_A_PACKAGE'); END IF;
  IF coalesce(l.session_no, 1) + 1 > v_n THEN RETURN jsonb_build_object('ok', false, 'error', 'SESSION_LIMIT', 'of', v_n); END IF;
  v_type := CASE WHEN l.commission_type = 'NONCOMMI' THEN 'NONCOMMI' WHEN l.assistant_id IS NOT NULL THEN 'LEAD' ELSE 'SOLO' END;
  r := public.log_visit(l.branch_id, l.service_date, l.service_id, 0, v_type, l.performer_id, l.assistant_id, NULL, 'Double dose', 'PAID', true);
  IF NOT coalesce((r ->> 'ok')::boolean, false) THEN RETURN r; END IF;
  v_id := (r ->> 'id')::uuid;
  UPDATE public.service_logs SET client_name = l.client_name, photo_folder = l.photo_folder, photos_due = false,
    session_no = coalesce(l.session_no, 1) + 1, booking_id = l.booking_id, list_price_cents = l.list_price_cents WHERE id = v_id;
  IF v_mgmt AND r ->> 'state' = 'PENDING' THEN
    UPDATE public.service_logs SET state = 'APPROVED', decided_by = v_user, decided_at = now() WHERE id = v_id AND state = 'PENDING';
    r := r || jsonb_build_object('state', 'APPROVED');
  END IF;
  RETURN r || jsonb_build_object('session', coalesce(l.session_no, 1) + 1);
END $$;
REVOKE ALL ON FUNCTION public.log_double_dose(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.log_double_dose(uuid) TO authenticated;

SELECT 'update-0095 is installed' AS result;
