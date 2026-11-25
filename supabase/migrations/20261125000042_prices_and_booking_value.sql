-- update-0042: price list and commissions per service, and expected value on bookings (Hermosa OS v0.42.0).
-- Owners and the GM add services and set price and commission; bookings take the price as their expected value,
-- and owners and managers see what the day's bookings are worth.

ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS expected_cents integer CHECK (expected_cents IS NULL OR expected_cents BETWEEN 0 AND 100000000);

-- save_booking gains p_expected_cents (the old 12-argument version is replaced).
DROP FUNCTION IF EXISTS public.save_booking(uuid, text, text, text, text, date, time, uuid, integer, date, boolean, text);
CREATE OR REPLACE FUNCTION public.save_booking(p_id uuid, p_client text, p_contact text, p_platform text, p_services text,
  p_date date, p_time time, p_branch uuid, p_deposit_cents integer, p_deposit_date date, p_follow_up boolean, p_note text, p_expected_cents integer DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id(); v_org uuid := private.current_org_id(); v_id uuid; old public.bookings%ROWTYPE;
        v_today date := (now() AT TIME ZONE 'Asia/Manila')::date;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT private.can_book() THEN RETURN private.deny(NULL, 'booking'); END IF;
  IF length(btrim(coalesce(p_client, ''))) < 2 OR length(btrim(coalesce(p_services, ''))) < 2 OR p_date IS NULL
     OR coalesce(p_platform, '') NOT IN ('FACEBOOK','INSTAGRAM','CALL','SMS','WALK_IN','OTHER')
     OR (p_deposit_cents IS NOT NULL AND p_deposit_cents < 0) OR (p_expected_cents IS NOT NULL AND p_expected_cents < 0) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
  END IF;
  IF p_date < v_today - 30 OR p_date > v_today + 365 THEN RETURN jsonb_build_object('ok', false, 'error', 'BOOKING_DATE'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE id = p_branch AND organization_id = v_org AND kind = 'CLINIC' AND active) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'UNKNOWN_BRANCH');
  END IF;
  IF p_id IS NULL THEN
    INSERT INTO public.bookings (organization_id, csr_employee_id, client_name, contact, platform, services, appointment_date, appointment_time,
      branch_id, deposit_cents, deposit_date, follow_up, note, created_by, expected_cents)
    VALUES (v_org, private.my_employee_id(), btrim(p_client), nullif(btrim(coalesce(p_contact, '')), ''), p_platform, btrim(p_services), p_date, p_time,
      p_branch, nullif(p_deposit_cents, 0), CASE WHEN coalesce(p_deposit_cents, 0) > 0 THEN coalesce(p_deposit_date, v_today) END,
      coalesce(p_follow_up, false), nullif(left(btrim(coalesce(p_note, '')), 300), ''), v_user, nullif(p_expected_cents, 0))
    RETURNING id INTO v_id;
    PERFORM private.audit(p_branch, 'BOOKING_ADDED', 'booking', v_id::text, NULL, NULL);
  ELSE
    SELECT * INTO old FROM public.bookings WHERE id = p_id AND organization_id = v_org FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
    UPDATE public.bookings SET client_name = btrim(p_client), contact = nullif(btrim(coalesce(p_contact, '')), ''), platform = p_platform,
      services = btrim(p_services), appointment_date = p_date, appointment_time = p_time, branch_id = p_branch,
      deposit_cents = nullif(p_deposit_cents, 0), deposit_date = CASE WHEN coalesce(p_deposit_cents, 0) > 0 THEN coalesce(p_deposit_date, old.deposit_date, v_today) END,
      follow_up = coalesce(p_follow_up, false), note = nullif(left(btrim(coalesce(p_note, '')), 300), ''),
      expected_cents = nullif(p_expected_cents, 0), updated_at = now()
    WHERE id = p_id;
    v_id := p_id;
    PERFORM private.audit(p_branch, 'BOOKING_CHANGED', 'booking', v_id::text, to_jsonb(old), NULL);
  END IF;
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END $$;

REVOKE ALL ON FUNCTION public.save_booking(uuid, text, text, text, text, date, time, uuid, integer, date, boolean, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_booking(uuid, text, text, text, text, date, time, uuid, integer, date, boolean, text, integer) TO authenticated;


-- ============ Services: price list and commission per service (CHRIS, Nov 25) ============
ALTER TABLE public.services ADD COLUMN IF NOT EXISTS price_cents bigint CHECK (price_cents IS NULL OR price_cents BETWEEN 0 AND 100000000);
-- Commission for one service done alone (SOLO). Lead/assist split it 60/40. Empty = 5% of the amount paid.
ALTER TABLE public.services ADD COLUMN IF NOT EXISTS commission_cents bigint CHECK (commission_cents IS NULL OR commission_cents BETWEEN 0 AND 100000000);
ALTER TABLE public.services ADD COLUMN IF NOT EXISTS updated_at timestamptz;

-- Add or change a service, its price and its commission. Owners and the GM.
CREATE OR REPLACE FUNCTION public.save_service(p_id uuid, p_name text, p_price_cents bigint, p_commission_cents bigint, p_active boolean)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id(); v_org uuid := private.current_org_id(); v_id uuid; old public.services%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT (private.has_role(ARRAY['OWNER'], NULL) OR private.is_gm()) THEN RETURN private.deny(NULL, 'service'); END IF;
  IF coalesce(length(btrim(p_name)), 0) < 2 OR length(btrim(p_name)) > 120 THEN RETURN jsonb_build_object('ok', false, 'error', 'NAME_REQUIRED'); END IF;
  IF coalesce(p_price_cents, 0) < 0 OR coalesce(p_commission_cents, 0) < 0 OR p_price_cents > 100000000 OR p_commission_cents > 100000000 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_AMOUNT');
  END IF;
  SELECT id INTO v_id FROM public.services WHERE organization_id = v_org AND lower(btrim(name)) = lower(btrim(p_name)) AND id IS DISTINCT FROM p_id;
  IF FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'SERVICE_EXISTS'); END IF;
  IF p_id IS NULL THEN
    INSERT INTO public.services (organization_id, name, price_cents, commission_cents, active, created_by, updated_at)
    VALUES (v_org, btrim(p_name), p_price_cents, p_commission_cents, coalesce(p_active, true), v_user, now()) RETURNING id INTO v_id;
    PERFORM private.audit(NULL, 'SERVICE_ADDED', 'service', v_id::text, NULL,
      jsonb_build_object('name', btrim(p_name), 'price_cents', p_price_cents, 'commission_cents', p_commission_cents));
  ELSE
    SELECT * INTO old FROM public.services WHERE id = p_id AND organization_id = v_org FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
    UPDATE public.services SET name = btrim(p_name), price_cents = p_price_cents, commission_cents = p_commission_cents,
      active = coalesce(p_active, true), updated_at = now() WHERE id = p_id;
    v_id := p_id;
    PERFORM private.audit(NULL, 'SERVICE_CHANGED', 'service', v_id::text,
      jsonb_build_object('name', old.name, 'price_cents', old.price_cents, 'commission_cents', old.commission_cents, 'active', old.active),
      jsonb_build_object('name', btrim(p_name), 'price_cents', p_price_cents, 'commission_cents', p_commission_cents, 'active', coalesce(p_active, true)));
  END IF;
  RETURN jsonb_build_object('ok', true, 'id', v_id);
END $$;
REVOKE ALL ON FUNCTION public.save_service(uuid, text, bigint, bigint, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_service(uuid, text, bigint, bigint, boolean) TO authenticated;

-- Commission: a set amount per service when there is one, else 5% (same signature as before).
CREATE OR REPLACE FUNCTION public.log_service(p_branch uuid, p_date date, p_service uuid, p_amount_cents bigint, p_type text,
  p_employee uuid, p_partner uuid, p_receipt text, p_note text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid := private.current_user_id();
  v_org uuid := private.current_org_id();
  v_type text; v_lead uuid; v_assist uuid;
  v_rate integer := 500; v_share integer := 6000;
  v_total bigint; v_lead_cents bigint; v_id uuid;
  lead_ok boolean; assist_ok boolean; v_fixed bigint;
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
  SELECT commission_cents INTO v_fixed FROM public.services WHERE id = p_service AND organization_id = v_org AND active;
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
  v_total := CASE WHEN v_fixed IS NOT NULL AND p_amount_cents > 0 THEN v_fixed ELSE (p_amount_cents * v_rate + 5000) / 10000 END;
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

-- CHRIS's price list as of Nov 25, 2026 (Services_Payment.xlsx). Adds missing services and sets prices and commissions;
-- services already in the app with the same name get the price and commission. Others are left as they are.
WITH list(name, price_cents, commission_cents) AS (VALUES
    ('Hiko Deluxe', 899900, 45000),
    ('Hiko Pro', 899900, 45000),
    ('Ultra Max Hiko', 1400000, 70000),
    ('Diamond Tip (No Alartox)', 600000, 30000),
    ('Diamond Tip (with Alartox)', 700000, 35000),
    ('Additional per Thread', 150000, 7500),
    ('Alar Botox', 400000, 20000),
    ('Fox Eye', 1400000, 70000),
    ('Hexalift', 1500000, 75000),
    ('Ultra VLift', 1000000, 50000),
    ('Additional Mono Thread (20pcs)', 600000, 30000),
    ('Additional Mono Thread (30pcs)', 850000, 42500),
    ('Additional Mono Thread (50pcs)', 1250000, 62500),
    ('Fillers', 899900, 45000),
    ('Signature facial', 100000, 5000),
    ('Diamond Peel', 100000, 5000),
    ('Acne Control', 100000, 5000),
    ('Glass Skin Hydrafacial', 150000, 7500),
    ('Carbon Laser Face', 250000, 12500),
    ('Acne Control + PDT', 150000, 7500),
    ('Acne Control + PDT + Kanolone', 250000, 12500),
    ('Kanolone', 150000, 7500),
    ('Hifu Face and Neck', 400000, 20000),
    ('Hifu Arms', 500000, 25000),
    ('Hifu Tummy', 600000, 30000),
    ('Hifu Back Fat', 700000, 35000),
    ('Microshading', 400000, 20000),
    ('Lip Blushing', 450000, 22500),
    ('BB Glow', 150000, 7500),
    ('BB Glow with BB Blush', 250000, 12500),
    ('Warts Removal Face', 150000, 7500),
    ('Warts Removal Face and Neck', 250000, 12500),
    ('Warts Removal Whole Body', 400000, 20000),
    ('Skin tag Face', 200000, 10000),
    ('Skin Tag Face and Neck', 300000, 15000),
    ('Skin Tag Whole Body', 450000, 22500),
    ('VContour', 150000, 7500),
    ('Mesolipo Arms/Tummy/Love Handle/ Backfat', 300000, 15000),
    ('Sweatox', 900000, 45000),
    ('Jawtox', 900000, 45000),
    ('Barbie Arms Trio', 800000, 40000),
    ('Barbie Shoulder', 800000, 40000),
    ('RF Face Single Session', 80000, 4000),
    ('RF Body Single Session', 150000, 7500),
    ('Face Botox Package', 900000, 45000),
    ('Botox: Forehead/Crowsfeet/Frownline/Nasal Fold (PER UNIT)', 30000, NULL),
    ('Botox: Undereye (PER UNIT)', 35000, NULL),
    ('UA Whitening Single session', 100000, 5000),
    ('UA Carbon Laser', 200000, 10000),
    ('Lemon Bottle Face Single Session', 300000, 15000),
    ('Lemon Bottle Arms/Love Handle/Backfat/Love Handle Single Session', 500000, 25000),
    ('Lux Queen Single Session', 300000, 15000),
    ('Illumina Single Session', 250000, 12500),
    ('Brilliant Single Session', 150000, 7500),
    ('Diode Upper Lip (Male)', 49900, 2500),
    ('Diode Upper Lip (Female)', 59900, 3000),
    ('Diode Lower Lip (Male)', 49900, 2500),
    ('Diode Lower Lip (Female)', 59900, 3000),
    ('Diode Full Face', 149900, 7500),
    ('Diode Underarms', 149900, 7500),
    ('Diode Arms', 149900, 7500),
    ('Diode Half Leg', 149900, 7500),
    ('Diode Full Legs', 199900, 20000),
    ('Diode Bikini Line', 199900, 20000),
    ('Diode Beard (Male)', 99900, 5000),
    ('Diode Upper Neck (Male)', 59900, 3000)
), org AS (
  SELECT o.id AS org_id, (SELECT g.user_id FROM public.role_grants g JOIN public.app_users u ON u.id = g.user_id
                           WHERE u.organization_id = o.id AND g.role_code = 'OWNER' AND g.revoked_at IS NULL ORDER BY g.created_at LIMIT 1) AS owner_id
  FROM public.organizations o
)
INSERT INTO public.services (organization_id, name, price_cents, commission_cents, created_by, updated_at)
SELECT org.org_id, l.name, l.price_cents, l.commission_cents, org.owner_id, now()
FROM list l CROSS JOIN org WHERE org.owner_id IS NOT NULL
ON CONFLICT (organization_id, lower(btrim(name))) DO UPDATE SET price_cents = EXCLUDED.price_cents, commission_cents = EXCLUDED.commission_cents, updated_at = now();
