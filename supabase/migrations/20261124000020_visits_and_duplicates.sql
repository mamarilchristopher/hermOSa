-- HERMOSA OS 0020: service log duplicates and unpaid visits (owner request 2026-11-24). Safe to run more than once.
-- * Staff and the general manager can both log the same client, so a new entry is checked first:
--   - the same waiver / OR no. at the branch (not rejected) is refused: DUPLICATE_RECEIPT;
--   - the same day, service, amount and staff as an entry already there asks "log anyway?": POSSIBLE_DUPLICATE
--     (the app shows who logged it and when, and only saves after the person confirms).
-- * Clients handled who did not pay can be logged: Backjob, Check-up or No charge. They count as ₱0, no commission.

ALTER TABLE public.service_logs ADD COLUMN IF NOT EXISTS visit_kind text NOT NULL DEFAULT 'PAID';
ALTER TABLE public.service_logs DROP CONSTRAINT IF EXISTS service_logs_visit_kind;
ALTER TABLE public.service_logs ADD CONSTRAINT service_logs_visit_kind
  CHECK (visit_kind IN ('PAID','BACKJOB','CHECKUP','NO_CHARGE') AND (visit_kind = 'PAID' OR amount_paid_cents = 0));
CREATE INDEX IF NOT EXISTS service_logs_receipt ON public.service_logs (branch_id, lower(receipt_no)) WHERE receipt_no IS NOT NULL;

-- visit_kind is fixed once logged, like the other entry fields.
CREATE OR REPLACE FUNCTION public.guard_service_logs() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'SERVICE_LOGS_ARE_NOT_DELETED'; END IF;
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

CREATE OR REPLACE FUNCTION public.log_visit(p_branch uuid, p_date date, p_service uuid, p_amount_cents bigint, p_type text,
  p_employee uuid, p_partner uuid, p_receipt text, p_note text, p_kind text, p_confirm boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_kind text := upper(coalesce(p_kind, 'PAID'));
  v_receipt text := nullif(btrim(coalesce(p_receipt, '')), '');
  v_type text := upper(coalesce(p_type, 'LEAD'));
  v_staff uuid[]; d record; r jsonb;
BEGIN
  IF private.current_user_id() IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT private.has_role(ARRAY['OWNER','FINANCE','MANAGER','CASHIER','CLINICIAN'], p_branch) THEN
    RETURN private.deny(p_branch, 'service_log');
  END IF;
  IF v_kind NOT IN ('PAID','BACKJOB','CHECKUP','NO_CHARGE') THEN RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST'); END IF;
  IF v_kind = 'PAID' AND coalesce(p_amount_cents, 0) <= 0 THEN RETURN jsonb_build_object('ok', false, 'error', 'INVALID_AMOUNT'); END IF;
  IF v_kind <> 'PAID' THEN p_amount_cents := 0; v_type := 'NONCOMMI'; p_partner := NULL; END IF;

  IF v_receipt IS NOT NULL THEN
    SELECT l.service_date, l.created_at, u.display_name AS by_name INTO d
    FROM public.service_logs l JOIN public.app_users u ON u.id = l.created_by
    WHERE l.branch_id = p_branch AND lower(l.receipt_no) = lower(v_receipt) AND l.state <> 'REJECTED' LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object('ok', false, 'error', 'DUPLICATE_RECEIPT',
        'existing', jsonb_build_object('date', d.service_date, 'by', d.by_name, 'at', d.created_at));
    END IF;
  END IF;

  IF NOT coalesce(p_confirm, false) THEN
    v_staff := array_remove(ARRAY[p_employee, p_partner], NULL);
    SELECT l.created_at, u.display_name AS by_name, l.amount_paid_cents INTO d
    FROM public.service_logs l JOIN public.app_users u ON u.id = l.created_by
    WHERE l.branch_id = p_branch AND l.service_date = p_date AND l.service_id = p_service AND l.state <> 'REJECTED'
      AND l.amount_paid_cents = p_amount_cents
      AND (l.performer_id = ANY (v_staff) OR l.assistant_id = ANY (v_staff))
    ORDER BY l.created_at DESC LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object('ok', false, 'error', 'POSSIBLE_DUPLICATE',
        'existing', jsonb_build_object('by', d.by_name, 'at', d.created_at, 'amount_cents', d.amount_paid_cents));
    END IF;
  END IF;

  r := public.log_service(p_branch, p_date, p_service, p_amount_cents, v_type, p_employee, p_partner, v_receipt, p_note);
  IF (r ->> 'ok')::boolean AND v_kind <> 'PAID' THEN
    UPDATE public.service_logs SET visit_kind = v_kind WHERE id = (r ->> 'id')::uuid;
  END IF;
  IF (r ->> 'ok')::boolean AND coalesce(p_confirm, false) THEN
    PERFORM private.audit(p_branch, 'SERVICE_LOGGED_DESPITE_DUPLICATE_WARNING', 'service_log', r ->> 'id', NULL, NULL);
  END IF;
  RETURN r;
END $$;

-- Commission entries waiting for sign-off, for the To do lists: the ones the caller can sign off (managers)
-- and the caller's own (staff), with the oldest date.
CREATE OR REPLACE FUNCTION public.pending_signoffs() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT jsonb_build_object(
    'to_sign', (SELECT jsonb_build_object('count', count(*), 'oldest', min(l.service_date))
                FROM public.service_logs l
                WHERE l.organization_id = private.current_org_id() AND l.state = 'PENDING'
                  AND private.has_role(ARRAY['OWNER','MANAGER'], l.branch_id)),
    'mine', (SELECT jsonb_build_object('count', count(*), 'oldest', min(l.service_date), 'cents', coalesce(sum(c.amount_cents), 0))
             FROM public.commission_lines c JOIN public.service_logs l ON l.id = c.service_log_id
             JOIN public.employees e ON e.id = c.employee_id
             WHERE e.app_user_id = private.current_user_id() AND l.state = 'PENDING'))
$$;

REVOKE ALL ON FUNCTION public.log_visit(uuid, date, uuid, bigint, text, uuid, uuid, text, text, text, boolean), public.pending_signoffs() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.log_visit(uuid, date, uuid, bigint, text, uuid, uuid, text, text, text, boolean), public.pending_signoffs() TO authenticated;
