-- update-0068 (CHRIS Nov 26, Services_Payment sheet): bundles as their own services, plus L-Carnitine.
--   * A bundle (e.g. Lux Queen 10+3) has a payment schedule: what the client pays at each session, 0 for the
--     sessions already paid for and the free ones. The Session No. picks the session; the app fills in its amount.
--   * Every session of a bundle pays its fixed commission (split 60/40 when there is an assistant), even ₱0 ones:
--     the bundle's list price is ₱0, so log_service always pays the set commission (update-0048 rule).
ALTER TABLE public.services ADD COLUMN IF NOT EXISTS session_prices bigint[];

WITH list(name, price_cents, commission_cents, sessions) AS (VALUES
    ('L-Carnitine', 50000::bigint, 2500::bigint, NULL::bigint[]),
    ('Lux Queen 10+3', 0, 8000, ARRAY[680000,250000,250000,250000,250000,250000,70000,0,0,0,0,0,0]::bigint[]),
    ('Lux Queen 5+1', 0, 12000, ARRAY[560000,210000,210000,210000,210000,0]::bigint[]),
    ('Illumina 10+3', 0, 8000, ARRAY[799900,200000,200000,200000,200000,200000,100000,100000,0,0,0,0,0]::bigint[]),
    ('Illumina 5+1', 0, 10000, ARRAY[660000,180000,180000,180000,0,0]::bigint[]),
    ('Brilliant 10+3', 0, 4000, ARRAY[400000,100000,100000,100000,100000,100000,50000,50000,0,0,0,0,0]::bigint[]),
    ('Brilliant 5+1', 0, 2500, ARRAY[390000,120000,120000,120000,0,0]::bigint[])
), org AS (
  SELECT o.id AS org_id, (SELECT g.user_id FROM public.role_grants g JOIN public.app_users u ON u.id = g.user_id
                           WHERE u.organization_id = o.id AND g.role_code = 'OWNER' AND g.revoked_at IS NULL ORDER BY g.created_at LIMIT 1) AS owner_id
  FROM public.organizations o
)
INSERT INTO public.services (organization_id, name, price_cents, commission_cents, session_prices, created_by, updated_at)
SELECT org.org_id, l.name, l.price_cents, l.commission_cents, l.sessions, org.owner_id, now()
FROM list l CROSS JOIN org WHERE org.owner_id IS NOT NULL
ON CONFLICT (organization_id, lower(btrim(name))) DO UPDATE SET price_cents = EXCLUDED.price_cents, commission_cents = EXCLUDED.commission_cents,
  session_prices = EXCLUDED.session_prices, active = true, updated_at = now();

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
