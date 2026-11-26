-- update-0085 (CHRIS Nov 27): a Hiko balance paid after a down payment (DP) earns 5% of the WHOLE package price,
-- not 5% of the balance. Staff tick "Balance after a DP" when logging it; owners and the GM can also mark or unmark
-- any entry below its list price ("Balance after DP" on the entry). Old Nov 1-24 entries: the traced Sta. Maria balance
-- (Nov 11, DP on Nov 1) is marked; the Nov 15 QC Hiko DP whose balance isn't in the logs gets the note
-- "With DP (Confirm with records)". Safe to run again.
-- CHECK FIRST (changes nothing):
-- select case when exists (select 1 from pg_proc where proname = 'set_after_dp') then 'ALREADY RUN: tick the box on your To-Do' else 'NOT RUN YET: run the rest of this file' end as result;

ALTER TABLE public.service_logs ADD COLUMN IF NOT EXISTS after_dp boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.guard_service_logs() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('hermosa.log_delete', true) = 'on' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'SERVICE_LOGS_ARE_NOT_DELETED';
  END IF;
  -- update-0085: marking a Hiko balance paid after a DP may change only the DP flag, the effective rate and the price note.
  IF current_setting('hermosa.after_dp', true) = 'on'
     AND (to_jsonb(NEW) - 'after_dp' - 'rate_bp' - 'price_note') = (to_jsonb(OLD) - 'after_dp' - 'rate_bp' - 'price_note') THEN RETURN NEW; END IF;
  -- update-0079: re-numbering may change the entry number only.
  IF current_setting('hermosa.log_renumber', true) = 'on'
     AND (to_jsonb(NEW) - 'log_no') = (to_jsonb(OLD) - 'log_no') THEN RETURN NEW; END IF;
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

CREATE OR REPLACE FUNCTION public.guard_commission_lines() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('hermosa.log_delete', true) = 'on' THEN RETURN OLD; END IF;
  -- update-0085: a DP balance may re-work the amount only.
  IF TG_OP = 'UPDATE' AND current_setting('hermosa.after_dp', true) = 'on'
     AND (to_jsonb(NEW) - 'amount_cents') = (to_jsonb(OLD) - 'amount_cents') THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'COMMISSION_LINES_ARE_IMMUTABLE';
END $$;

-- Mark (or unmark) an entry as the balance paid after a DP. On: commission = 5% of the list price, split as logged.
-- Off: back to 5% of what was paid (the discounted-price rule). Who: owners and the GM, or whoever logged it while
-- it still waits for sign-off. Not once its commission is on a final payslip.
CREATE OR REPLACE FUNCTION public.set_after_dp(p_log uuid, p_on boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid := private.current_user_id(); l public.service_logs; v_price bigint; v_total bigint; v_rate integer;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  SELECT * INTO l FROM public.service_logs WHERE id = p_log AND organization_id = private.current_org_id() FOR UPDATE;
  IF NOT FOUND OR l.state = 'REJECTED' THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF NOT (private.is_management(v_user) OR (l.created_by = v_user AND l.state = 'PENDING')) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_ALLOWED');
  END IF;
  IF coalesce(p_on, false) = l.after_dp THEN RETURN jsonb_build_object('ok', true, 'id', l.id); END IF;
  SELECT coalesce(l.list_price_cents, s.price_cents) INTO v_price FROM public.services s WHERE s.id = l.service_id;
  IF coalesce(l.visit_kind, 'PAID') <> 'PAID' OR v_price IS NULL OR v_price <= 0 OR l.amount_paid_cents <= 0 OR l.amount_paid_cents >= v_price THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_A_BALANCE');
  END IF;
  IF EXISTS (SELECT 1 FROM public.commission_paid cp JOIN public.commission_lines c ON c.id = cp.commission_line_id WHERE c.service_log_id = l.id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ALREADY_PAID');
  END IF;
  v_total := CASE WHEN p_on THEN (v_price * 500 + 5000) / 10000 ELSE (l.amount_paid_cents * 500 + 5000) / 10000 END;
  v_rate := CASE WHEN l.commission_type = 'NONCOMMI' THEN 0 ELSE least(10000, ((v_total * 10000 + l.amount_paid_cents / 2) / l.amount_paid_cents)::integer) END;
  PERFORM set_config('hermosa.after_dp', 'on', true);
  UPDATE public.service_logs SET after_dp = coalesce(p_on, false), rate_bp = v_rate,
    price_note = CASE WHEN p_on AND coalesce(btrim(price_note), '') = '' THEN 'Balance after DP' ELSE price_note END
  WHERE id = l.id;
  UPDATE public.commission_lines c SET amount_cents = CASE c.role
      WHEN 'SOLO' THEN v_total
      WHEN 'LEAD' THEN (v_total * l.lead_share_bp + 5000) / 10000
      ELSE v_total - (v_total * l.lead_share_bp + 5000) / 10000 END
  WHERE c.service_log_id = l.id;
  PERFORM set_config('hermosa.after_dp', 'off', true);
  PERFORM private.audit(l.branch_id, 'SERVICE_AFTER_DP', 'service_log', l.id::text, NULL, jsonb_build_object('on', p_on, 'commission_cents', v_total));
  RETURN jsonb_build_object('ok', true, 'id', l.id, 'commission_cents', v_total);
END $$;
REVOKE ALL ON FUNCTION public.set_after_dp(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_after_dp(uuid, boolean) TO authenticated;

-- Old paper logs (imported Nov 27). Only touches the imported lines, only once.
DO $$
BEGIN
  PERFORM set_config('hermosa.after_dp', 'on', true);
  -- Sta. Maria, Nov 11: Hiko Deluxe balance ₱8,500 after the ₱500 DP of Nov 1 (commission already ₱450 on the sheet).
  UPDATE public.service_logs l SET after_dp = true,
    price_note = 'Balance after ₱500 DP on Nov 1' || CASE WHEN coalesce(btrim(l.price_note), '') <> '' THEN ' · ' || l.price_note ELSE '' END
  FROM public.services s, public.branches b
  WHERE s.id = l.service_id AND b.id = l.branch_id AND l.note = 'Old paper log import' AND NOT l.after_dp
    AND b.code = 'STA_MARIA' AND l.service_date = date '2026-11-11' AND s.name = 'Hiko Deluxe' AND l.amount_paid_cents = 850000;
  -- QC Main, Nov 15: ₱1,000 Hiko DP whose balance isn't in the Nov 1-24 logs.
  UPDATE public.service_logs l SET price_note = 'With DP (Confirm with records)'
  FROM public.services s, public.branches b
  WHERE s.id = l.service_id AND b.id = l.branch_id AND l.note = 'Old paper log import'
    AND b.code = 'QC_MAIN' AND l.service_date = date '2026-11-15' AND s.name = 'Hiko DP' AND l.amount_paid_cents = 100000
    AND l.price_note IS DISTINCT FROM 'With DP (Confirm with records)';
  PERFORM set_config('hermosa.after_dp', 'off', true);
END $$;

-- Hiko entries logged in the app below their list price that may be balances after a DP (mark them on the entry).
SELECT 'update-0085 is installed' AS result, NULL::text AS entry, NULL::text AS service, NULL::text AS paid
UNION ALL
SELECT 'Check: below list price', coalesce(l.log_no, '') || ' ' || coalesce(l.client_name, '') || ' (' || to_char(l.service_date, 'Mon DD') || ')',
       s.name, '₱' || to_char(l.amount_paid_cents / 100.0, 'FM999,990.00') || ' of ₱' || to_char(coalesce(l.list_price_cents, s.price_cents) / 100.0, 'FM999,990.00')
FROM public.service_logs l JOIN public.services s ON s.id = l.service_id
WHERE s.name ILIKE '%hiko%' AND s.name <> 'Hiko DP' AND l.state <> 'REJECTED' AND NOT l.after_dp AND coalesce(l.visit_kind, 'PAID') = 'PAID'
  AND l.amount_paid_cents > 0 AND l.amount_paid_cents < coalesce(l.list_price_cents, s.price_cents)
  AND coalesce(l.note, '') <> 'Old paper log import';
