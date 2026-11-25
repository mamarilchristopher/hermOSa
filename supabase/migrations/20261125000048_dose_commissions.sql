-- update-0048: per-dose commission for packages paid up front (CHRIS's Services_Payment price list, Nov 25, 2026).
--   * Barbie Arms Trio (P8,000 for 3 doses): P300 commission on the 1st dose (when paid), P50 on the 2nd and P50 on the 3rd.
--   * The 2nd and 3rd doses are their own services at P0 with a set commission, logged with P0 paid.
--   * log_service: a service priced at P0 with a set commission pays that commission even when nothing is paid that visit.

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

WITH list(name, price_cents, commission_cents) AS (VALUES
    ('Barbie Arms Trio', 800000, 30000),
    ('Barbie Arms Trio 2nd dose', 0, 5000),
    ('Barbie Arms Trio 3rd dose', 0, 5000)
), org AS (
  SELECT o.id AS org_id, (SELECT g.user_id FROM public.role_grants g JOIN public.app_users u ON u.id = g.user_id
                           WHERE u.organization_id = o.id AND g.role_code = 'OWNER' AND g.revoked_at IS NULL ORDER BY g.created_at LIMIT 1) AS owner_id
  FROM public.organizations o
)
INSERT INTO public.services (organization_id, name, price_cents, commission_cents, created_by, updated_at)
SELECT org.org_id, l.name, l.price_cents, l.commission_cents, org.owner_id, now()
FROM list l CROSS JOIN org WHERE org.owner_id IS NOT NULL
ON CONFLICT (organization_id, lower(btrim(name))) DO UPDATE SET price_cents = EXCLUDED.price_cents, commission_cents = EXCLUDED.commission_cents, active = true, updated_at = now();
