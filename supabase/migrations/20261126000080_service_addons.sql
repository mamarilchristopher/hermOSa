-- update-0080 (CHRIS Nov 26): add-ons on the service log, e.g. an extra L-Carnitine with a Lux Queen drip.
--   The main service keeps its own commission (fixed or 5%); each add-on pays 5% of what was paid for it,
--   split 60/40 when there's an assistant. Each add-on is saved as its own line of the same visit
--   (same client, date, Done by and Assisted by), so it counts in the day's sales.
ALTER TABLE public.services ADD COLUMN IF NOT EXISTS is_addon boolean NOT NULL DEFAULT false;
UPDATE public.services SET is_addon = true WHERE lower(btrim(name)) = 'l-carnitine';

-- Owners and the GM mark a service as an add-on (price list page).
CREATE OR REPLACE FUNCTION public.set_service_addon(p_id uuid, p_on boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF private.current_user_id() IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT private.is_management(private.current_user_id()) THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_ALLOWED'); END IF;
  UPDATE public.services SET is_addon = coalesce(p_on, false), updated_at = now()
  WHERE id = p_id AND organization_id = private.current_org_id() AND NOT is_meds;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'UNKNOWN_SERVICE'); END IF;
  RETURN jsonb_build_object('ok', true);
END $$;
REVOKE ALL ON FUNCTION public.set_service_addon(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_service_addon(uuid, boolean) TO authenticated;

-- log_service as in update-0053, plus: while hermosa.addon = '1' (set only by log_addon) the set commission
-- is ignored and the line pays 5% of the amount paid.
CREATE OR REPLACE FUNCTION public.log_service(p_branch uuid, p_date date, p_service uuid, p_amount_cents bigint, p_type text,
  p_employee uuid, p_partner uuid, p_receipt text, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid := private.current_user_id();
  v_org uuid := private.current_org_id();
  v_type text; v_lead uuid; v_assist uuid;
  v_rate integer := 500; v_share integer := 6000;
  v_total bigint; v_lead_cents bigint; v_id uuid;
  lead_ok boolean; assist_ok boolean; v_fixed bigint; v_price bigint;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = p_branch AND organization_id = v_org AND kind = 'CLINIC') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'UNKNOWN_BRANCH');
  END IF;
  IF NOT private.has_role(ARRAY['OWNER','FINANCE','MANAGER','CASHIER','CLINICIAN'], p_branch) THEN
    RETURN private.deny(p_branch, 'service_log');
  END IF;
  IF p_date IS NULL OR p_date > (now() AT TIME ZONE 'Asia/Manila')::date THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_DATE');
  END IF;
  IF p_amount_cents IS NULL OR p_amount_cents < 0 OR p_amount_cents > 100000000 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_AMOUNT');
  END IF;
  SELECT commission_cents, price_cents INTO v_fixed, v_price FROM public.services WHERE id = p_service AND organization_id = v_org AND active;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'UNKNOWN_SERVICE'); END IF;
  -- update-0080: an add-on line always pays 5% of what was paid for it.
  IF current_setting('hermosa.addon', true) = '1' THEN v_fixed := NULL; END IF;
  -- update-0053: a discounted price (less than the list price) earns 5% of what was actually paid, not the set commission.
  IF v_fixed IS NOT NULL AND v_price IS NOT NULL AND p_amount_cents > 0 AND p_amount_cents < v_price THEN v_fixed := NULL; END IF;
  -- update-0042: a service with a set commission pays that amount (split 60/40 for lead/assist) on any paid visit;
  -- otherwise 5% of the amount paid. The stored rate is the effective one, for the record.
  IF v_fixed IS NOT NULL AND coalesce(p_amount_cents, 0) > 0 THEN
    v_rate := least(10000, ((v_fixed * 10000 + p_amount_cents / 2) / p_amount_cents)::integer);
  END IF;
  v_type := upper(coalesce(p_type, 'LEAD'));
  IF v_type = 'ASSIST' THEN v_type := 'LEAD'; v_lead := p_partner; v_assist := p_employee;
  ELSIF v_type = 'LEAD' THEN v_lead := p_employee; v_assist := p_partner;
  ELSIF v_type IN ('SOLO','NONCOMMI') THEN v_lead := p_employee; v_assist := NULL;
  ELSE RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
  END IF;
  IF v_lead IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'EMPLOYEE_REQUIRED'); END IF;
  IF v_type = 'LEAD' AND v_assist IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'ASSISTANT_REQUIRED'); END IF;
  IF v_assist = v_lead THEN RETURN jsonb_build_object('ok', false, 'error', 'SAME_PERSON'); END IF;
  SELECT commission_eligible INTO lead_ok FROM public.employees WHERE id = v_lead AND organization_id = v_org AND active;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'UNKNOWN_EMPLOYEE'); END IF;
  IF v_assist IS NOT NULL THEN
    SELECT commission_eligible INTO assist_ok FROM public.employees WHERE id = v_assist AND organization_id = v_org AND active;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'UNKNOWN_EMPLOYEE'); END IF;
  END IF;

  INSERT INTO public.service_logs (organization_id, branch_id, service_date, service_id, amount_paid_cents, commission_type,
    performer_id, assistant_id, rate_bp, lead_share_bp, receipt_no, note, created_by)
  VALUES (v_org, p_branch, p_date, p_service, p_amount_cents, v_type, v_lead, v_assist,
    CASE WHEN v_type = 'NONCOMMI' THEN 0 ELSE v_rate END, v_share,
    nullif(btrim(coalesce(p_receipt, '')), ''), nullif(btrim(coalesce(p_note, '')), ''), v_user)
  RETURNING id INTO v_id;

  -- Commission in centavos, rounded half up; the lead's share is rounded and the assistant gets the rest.
  -- update-0048: a follow-up dose already paid for (price 0 with a set commission) still pays its set commission.
  v_total := CASE WHEN v_fixed IS NOT NULL AND (p_amount_cents > 0 OR coalesce(v_price, 0) = 0) THEN v_fixed ELSE (p_amount_cents * v_rate + 5000) / 10000 END;
  IF v_type = 'SOLO' AND lead_ok THEN
    INSERT INTO public.commission_lines (service_log_id, employee_id, role, amount_cents) VALUES (v_id, v_lead, 'SOLO', v_total);
  ELSIF v_type = 'LEAD' THEN
    v_lead_cents := (v_total * v_share + 5000) / 10000;
    IF lead_ok THEN
      INSERT INTO public.commission_lines (service_log_id, employee_id, role, amount_cents) VALUES (v_id, v_lead, 'LEAD', v_lead_cents);
    END IF;
    IF assist_ok THEN
      INSERT INTO public.commission_lines (service_log_id, employee_id, role, amount_cents) VALUES (v_id, v_assist, 'ASSIST', v_total - v_lead_cents);
    END IF;
  END IF;

  PERFORM private.audit(p_branch, 'SERVICE_LOGGED', 'service_log', v_id::text, NULL,
    jsonb_build_object('date', p_date, 'type', v_type, 'amount_paid_cents', p_amount_cents));
  RETURN jsonb_build_object('ok', true, 'id', v_id, 'state', 'PENDING');
END $$;
REVOKE ALL ON FUNCTION public.log_service(uuid, date, uuid, bigint, text, uuid, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.log_service(uuid, date, uuid, bigint, text, uuid, uuid, text, text) TO authenticated;

-- Add an add-on to a visit just saved. p_log = the main service line; p_amount_cents = what was paid for the add-on.
CREATE OR REPLACE FUNCTION public.log_addon(p_log uuid, p_service uuid, p_amount_cents bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid := private.current_user_id(); v_org uuid := private.current_org_id();
  l record; s record; r jsonb; v_id uuid; v_type text; v_mgmt boolean := private.is_management(private.current_user_id());
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  SELECT * INTO l FROM public.service_logs WHERE id = p_log AND organization_id = v_org;
  IF NOT FOUND OR l.state = 'REJECTED' THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF l.created_by <> v_user AND NOT v_mgmt THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_ALLOWED'); END IF;
  IF coalesce(l.visit_kind, 'PAID') <> 'PAID' THEN RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST'); END IF;
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 THEN RETURN jsonb_build_object('ok', false, 'error', 'INVALID_AMOUNT'); END IF;
  SELECT id, name, price_cents INTO s FROM public.services WHERE id = p_service AND organization_id = v_org AND active AND is_addon AND NOT is_meds;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'UNKNOWN_SERVICE'); END IF;

  -- Same people and split as the main line: Solo, Lead + assist, or no commission.
  v_type := CASE WHEN l.commission_type = 'NONCOMMI' THEN 'NONCOMMI' WHEN l.assistant_id IS NOT NULL THEN 'LEAD' ELSE 'SOLO' END;
  PERFORM set_config('hermosa.addon', '1', true);
  r := public.log_visit(l.branch_id, l.service_date, p_service, p_amount_cents, v_type, l.performer_id, l.assistant_id,
    NULL, 'Add-on', 'PAID', true);
  PERFORM set_config('hermosa.addon', '', true);
  IF NOT coalesce((r ->> 'ok')::boolean, false) THEN RETURN r; END IF;
  v_id := (r ->> 'id')::uuid;
  UPDATE public.service_logs SET client_name = l.client_name, list_price_cents = s.price_cents, photo_folder = l.photo_folder,
    photos_due = false, session_no = 1 WHERE id = v_id;
  IF v_mgmt AND r ->> 'state' = 'PENDING' THEN
    UPDATE public.service_logs SET state = 'APPROVED', decided_by = v_user, decided_at = now() WHERE id = v_id AND state = 'PENDING';
    r := r || jsonb_build_object('state', 'APPROVED');
  END IF;
  RETURN r;
END $$;
REVOKE ALL ON FUNCTION public.log_addon(uuid, uuid, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.log_addon(uuid, uuid, bigint) TO authenticated;
