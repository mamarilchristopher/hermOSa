-- update-0103 (CHRIS Nov 28): every paid service entry records the ACCOUNT the payment went to (where the money
-- landed, not the app the client paid from): Credit card, Cash, GCash, BPI, Maya, MariBank, UnionBank or PSBank.
-- Picked on "Add a service"; owners and the GM can change it on any entry. One visit (merged lines) shares one account.
-- Safe to run again.
-- CHECK FIRST (changes nothing):
-- select case when exists (select 1 from pg_proc where proname = 'set_service_paid_to') then 'ALREADY RUN: tick the box on your To-Do' else 'NOT RUN YET: run the rest of this file' end as result;

ALTER TABLE public.service_logs ADD COLUMN IF NOT EXISTS paid_to text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'service_logs_paid_to_check') THEN
    ALTER TABLE public.service_logs ADD CONSTRAINT service_logs_paid_to_check
      CHECK (paid_to IS NULL OR paid_to IN ('CARD','CASH','GCASH','BPI','MAYA','MARIBANK','UNIONBANK','PSBANK'));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.guard_service_logs() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('hermosa.log_delete', true) = 'on' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'SERVICE_LOGS_ARE_NOT_DELETED';
  END IF;
  -- update-0103: setting the account the payment went to may change only that.
  IF current_setting('hermosa.paid_to', true) = 'on'
     AND (to_jsonb(NEW) - 'paid_to') = (to_jsonb(OLD) - 'paid_to') THEN RETURN NEW; END IF;
  -- update-0091: linking an entry to its booking may change only the booking link and the client name (waiver name).
  IF current_setting('hermosa.booking_link', true) = 'on'
     AND (to_jsonb(NEW) - 'booking_id' - 'client_name') = (to_jsonb(OLD) - 'booking_id' - 'client_name') THEN RETURN NEW; END IF;
  -- update-0085: marking a Hiko balance paid after a DP may change only the DP flag, the effective rate and the price note.
  IF current_setting('hermosa.after_dp', true) = 'on'
     AND (to_jsonb(NEW) - 'after_dp' - 'rate_bp' - 'price_note') = (to_jsonb(OLD) - 'after_dp' - 'rate_bp' - 'price_note') THEN RETURN NEW; END IF;
  -- update-0101: merging a meds / add-on line into its main sale may change only the merge link and the entry number.
  IF current_setting('hermosa.log_merge', true) = 'on'
     AND (to_jsonb(NEW) - 'merged_into' - 'log_no') = (to_jsonb(OLD) - 'merged_into' - 'log_no') THEN RETURN NEW; END IF;
  -- update-0079: re-numbering may change the entry number only.
  IF current_setting('hermosa.log_renumber', true) = 'on'
     AND (to_jsonb(NEW) - 'log_no') = (to_jsonb(OLD) - 'log_no') THEN RETURN NEW; END IF;
  -- update-0095: change_service_branch may move the branch only.
  IF current_setting('hermosa.log_rebranch', true) = 'on'
     AND (to_jsonb(NEW) - 'branch_id') = (to_jsonb(OLD) - 'branch_id') THEN RETURN NEW; END IF;
  -- update-0095: fixing a past entry may change only its kind, split, state and decision (owners / GM fixes).
  IF current_setting('hermosa.log_fix', true) = 'on'
     AND (to_jsonb(NEW) - 'visit_kind' - 'commission_type' - 'state' - 'decided_by' - 'decided_at' - 'decision_note')
       = (to_jsonb(OLD) - 'visit_kind' - 'commission_type' - 'state' - 'decided_by' - 'decided_at' - 'decision_note') THEN RETURN NEW; END IF;
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


-- Set (or clear) the account for an entry's whole visit (the main sale and every line merged under it).
-- Who: owners and the GM on any entry; the person who entered it, did it or assisted while it still waits for sign-off.
CREATE OR REPLACE FUNCTION public.set_service_paid_to(p_log uuid, p_paid_to text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id(); l public.service_logs%ROWTYPE; v_to text := nullif(upper(btrim(coalesce(p_paid_to, ''))), ''); v_n integer;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF v_to IS NOT NULL AND v_to NOT IN ('CARD','CASH','GCASH','BPI','MAYA','MARIBANK','UNIONBANK','PSBANK') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_ACCOUNT');
  END IF;
  SELECT * INTO l FROM public.service_logs WHERE id = p_log AND organization_id = private.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF l.merged_into IS NOT NULL THEN
    SELECT * INTO l FROM public.service_logs WHERE id = l.merged_into FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  END IF;
  IF l.state = 'REJECTED' THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF NOT (private.is_management(v_user)
          OR (l.state = 'PENDING' AND (l.created_by = v_user
              OR EXISTS (SELECT 1 FROM public.employees e WHERE e.app_user_id = v_user AND e.id IN (l.performer_id, l.assistant_id))))) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'NOT_ALLOWED');
  END IF;
  PERFORM set_config('hermosa.paid_to', 'on', true);
  UPDATE public.service_logs SET paid_to = v_to WHERE (id = l.id OR merged_into = l.id) AND paid_to IS DISTINCT FROM v_to;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM set_config('hermosa.paid_to', 'off', true);
  IF v_n > 0 THEN
    PERFORM private.audit(l.branch_id, 'SERVICE_PAID_TO', 'service_log', l.id::text, NULL, jsonb_build_object('paid_to', v_to, 'lines', v_n));
  END IF;
  RETURN jsonb_build_object('ok', true, 'id', l.id, 'paid_to', v_to, 'lines', v_n);
END $$;
REVOKE ALL ON FUNCTION public.set_service_paid_to(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_service_paid_to(uuid, text) TO authenticated;
