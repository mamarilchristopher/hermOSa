-- update-0106 (CHRIS Nov 28, v0.106.0): a backjob may be paid. Add a service › Backjob now shows the service price,
--   editable down to ₱0 (backjobs are often free). log_visit used to save every backjob at ₱0; it now keeps the amount
--   typed. Backjobs still pay no commission. A backjob saved at ₱0 shows as "<Service> (retouch/backjob)" in the app.
--   Everything else is as in update-0068.

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
  -- update-0068: ₱0 is a valid paid session for services priced ₱0 with a set commission (bundle sessions already
  -- paid for or free, Barbie Arms 2nd/3rd dose); the commission is still paid.
  IF v_kind = 'PAID' AND coalesce(p_amount_cents, 0) <= 0 AND NOT EXISTS (
       SELECT 1 FROM public.services s WHERE s.id = p_service AND s.organization_id = private.current_org_id()
         AND coalesce(s.price_cents, 0) = 0 AND s.commission_cents IS NOT NULL AND p_amount_cents = 0) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_AMOUNT');
  END IF;
  -- update-0106 (CHRIS Nov 28): a backjob keeps what the client paid (₱0 when free); still no commission.
  IF v_kind = 'BACKJOB' AND (p_amount_cents IS NULL OR p_amount_cents < 0) THEN RETURN jsonb_build_object('ok', false, 'error', 'INVALID_AMOUNT'); END IF;
  IF v_kind <> 'PAID' THEN
    IF v_kind <> 'BACKJOB' THEN p_amount_cents := 0; END IF;
    v_type := 'NONCOMMI'; p_partner := NULL;
  END IF;

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

REVOKE ALL ON FUNCTION public.log_visit(uuid, date, uuid, bigint, text, uuid, uuid, text, text, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.log_visit(uuid, date, uuid, bigint, text, uuid, uuid, text, text, text, boolean) TO authenticated;
