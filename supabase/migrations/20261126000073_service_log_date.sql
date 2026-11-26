-- update-0073 (CHRIS Nov 26): management (owners and the GM) can fix the date of a service log entry entered on the wrong day.
-- Only the date changes; everything else stays locked. Blocked once its commission is on a final payslip.

CREATE OR REPLACE FUNCTION public.guard_service_logs() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('hermosa.log_delete', true) = 'on' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'SERVICE_LOGS_ARE_NOT_DELETED';
  END IF;
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

CREATE OR REPLACE FUNCTION public.change_service_date(p_log uuid, p_date date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE l public.service_logs; v_user uuid := private.current_user_id();
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  SELECT * INTO l FROM public.service_logs WHERE id = p_log AND organization_id = private.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF NOT private.is_management(v_user) OR NOT private.has_role(ARRAY['OWNER','MANAGER'], l.branch_id) THEN
    RETURN private.deny(l.branch_id, 'service_log');
  END IF;
  IF p_date IS NULL OR p_date > (now() AT TIME ZONE 'Asia/Manila')::date OR p_date < date '2024-01-01' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_DATE');
  END IF;
  IF p_date = l.service_date THEN RETURN jsonb_build_object('ok', true, 'id', l.id); END IF;
  IF EXISTS (SELECT 1 FROM public.commission_paid cp JOIN public.commission_lines c ON c.id = cp.commission_line_id WHERE c.service_log_id = l.id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ALREADY_PAID');
  END IF;
  PERFORM set_config('hermosa.log_redate', 'on', true);
  UPDATE public.service_logs SET service_date = p_date WHERE id = l.id;
  PERFORM set_config('hermosa.log_redate', 'off', true);
  PERFORM private.audit(l.branch_id, 'SERVICE_LOG_REDATED', 'service_log', l.id::text,
    jsonb_build_object('date', l.service_date), jsonb_build_object('date', p_date));
  RETURN jsonb_build_object('ok', true, 'id', l.id);
END $$;
REVOKE ALL ON FUNCTION public.change_service_date(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.change_service_date(uuid, date) TO authenticated;
