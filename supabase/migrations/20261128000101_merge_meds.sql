-- Hermosa OS update-0101: merge entries of one visit under the main sale's SL number (CHRIS Nov 28). Safe to run again.
-- SQL Editor: https://supabase.com/dashboard/project/bnopatuopnenbdhrecdt/sql/new
-- "for sales like this, same client but 2 entries due to meds purchase, there should be a merge option but the sales of
--  the main service would prevail as SL id" + "not just meds merge but multi service single waiver clients"
--   1. service_logs.merged_into: a line (meds, add-on or another service) that belongs to a main sale. It keeps its own amount (so
--      sales by service and commissions don't change) but shows inside the main entry and has no SL number of its own:
--      the main sale's number is the visit's number.
--   2. merge_service_entry(main, line): owners, the GM and the branch's managers merge a line of the same client, day
--      and branch into the main sale. A waiting line under an approved sale is approved with it. One waiver covers the
--      visit: when the main sale has its waiver, merged lines stop waiting for photos (their commission counts).
--      separate_service_entry(line) undoes it (the line gets its own number again).
--   3. From now on, meds and add-ons picked in "Add a service" go under the main sale by themselves.
--   4. Monthly re-numbering skips merged lines.
-- CHECK FIRST (changes nothing):
-- select case when exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'service_logs' and column_name = 'merged_into') and exists (select 1 from pg_proc where proname = 'merge_service_entry') then 'ALREADY RUN: tick the box on your To-Do' else 'NOT RUN YET: run the rest of this file' end as result;

ALTER TABLE public.service_logs ADD COLUMN IF NOT EXISTS merged_into uuid REFERENCES public.service_logs(id);
CREATE INDEX IF NOT EXISTS service_logs_merged_into ON public.service_logs (merged_into) WHERE merged_into IS NOT NULL;

-- The guard of update-0095, plus the merge.
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

-- Monthly re-numbering (update-0098), skipping merged lines.
CREATE OR REPLACE FUNCTION private.renumber_month(p_org uuid, p_month date) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_s date := date_trunc('month', p_month)::date; v_e date := (date_trunc('month', p_month) + interval '1 month')::date;
  v_n integer; r record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('log_no_month:' || p_org::text || to_char(v_s, 'YYYY-MM')));
  PERFORM set_config('hermosa.log_renumber', 'on', true);
  -- Clear first so the new order never collides with an old number (entries of this month, and any still carrying
  -- one of this month's numbers after a date change).
  -- update-0101: lines merged into a main sale carry no number of their own.
  UPDATE public.service_logs SET log_no = CASE WHEN merged_into IS NULL THEN 'TMP-' || id::text END
  WHERE organization_id = p_org
    AND ((service_date >= v_s AND service_date < v_e)
         OR EXISTS (SELECT 1 FROM generate_series(v_s, v_e - 1, interval '1 day') d WHERE log_no LIKE private.log_prefix(d::date) || '%'));
  WITH o AS (
    SELECT id, service_date, row_number() OVER (PARTITION BY service_date ORDER BY private.branch_rank(branch_id), created_at, id) AS n
    FROM public.service_logs
    WHERE organization_id = p_org AND service_date >= v_s AND service_date < v_e AND merged_into IS NULL
  )
  UPDATE public.service_logs l SET log_no = private.log_prefix(o.service_date) || lpad(o.n::text, 3, '0') FROM o WHERE l.id = o.id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  -- An entry moved out of this month keeps a number on its own day.
  FOR r IN SELECT id, service_date FROM public.service_logs WHERE organization_id = p_org AND log_no LIKE 'TMP-%' ORDER BY service_date, created_at LOOP
    UPDATE public.service_logs SET log_no = private.log_prefix(r.service_date) || lpad((coalesce((SELECT max(nullif(split_part(log_no, '-', 3), '')::integer)
        FROM public.service_logs WHERE organization_id = p_org AND log_no LIKE private.log_prefix(r.service_date) || '%'), 0) + 1)::text, 3, '0')
    WHERE id = r.id;
  END LOOP;
  PERFORM set_config('hermosa.log_renumber', 'off', true);
  RETURN v_n;
END $$;

-- Same visit? Same branch, day and client name (any spacing or capitals).
CREATE OR REPLACE FUNCTION private.same_visit(a public.service_logs, b public.service_logs) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT a.organization_id = b.organization_id AND a.branch_id = b.branch_id AND a.service_date = b.service_date
     AND a.client_name IS NOT NULL AND b.client_name IS NOT NULL
     AND lower(regexp_replace(btrim(a.client_name), '\s+', ' ', 'g')) = lower(regexp_replace(btrim(b.client_name), '\s+', ' ', 'g'))
$$;
REVOKE ALL ON FUNCTION private.same_visit(public.service_logs, public.service_logs) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.merge_service_entry(p_main uuid, p_line uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id(); m public.service_logs%ROWTYPE; x public.service_logs%ROWTYPE; v_n integer := 0;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF p_main IS NULL OR p_line IS NULL OR p_main = p_line THEN RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST'); END IF;
  SELECT * INTO m FROM public.service_logs WHERE id = p_main AND organization_id = private.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  SELECT * INTO x FROM public.service_logs WHERE id = p_line AND organization_id = private.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF NOT (private.has_role(ARRAY['OWNER','MANAGER'], m.branch_id) OR private.is_gm()) THEN RETURN private.deny(m.branch_id, 'service_log.merge'); END IF;
  IF m.state = 'REJECTED' OR x.state = 'REJECTED' THEN RETURN jsonb_build_object('ok', false, 'error', 'REJECTED'); END IF;
  IF m.merged_into IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'MAIN_IS_MERGED'); END IF;
  IF x.merged_into = m.id THEN RETURN jsonb_build_object('ok', true, 'id', m.id, 'log_no', m.log_no); END IF;
  IF NOT private.same_visit(m, x) THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_SAME_VISIT'); END IF;
  IF EXISTS (SELECT 1 FROM public.services s WHERE s.id = m.service_id AND s.is_meds) THEN RETURN jsonb_build_object('ok', false, 'error', 'MAIN_IS_MEDS'); END IF;

  PERFORM set_config('hermosa.log_merge', 'on', true);
  -- The line, and anything already merged into it, go under the main sale.
  UPDATE public.service_logs SET merged_into = m.id, log_no = NULL WHERE id = x.id OR merged_into = x.id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM set_config('hermosa.log_merge', 'off', true);
  -- One waiver for the visit (CHRIS Nov 28: "multi service single waiver clients"): when the main sale has its waiver
  -- and photos, the merged lines no longer wait for photos of their own (their commission counts).
  IF NOT m.photos_due AND EXISTS (SELECT 1 FROM public.service_photos p WHERE p.service_log_id = m.id AND p.kind = 'WAIVER' AND p.archived_at IS NULL) THEN
    DELETE FROM public.notifications n USING public.service_logs l
    WHERE l.merged_into = m.id AND l.photos_due AND n.kind = 'PHOTOS_DUE' AND n.link LIKE '%&entry=' || l.id::text;
    PERFORM set_config('hermosa.photo_sharing', 'on', true);
    UPDATE public.service_logs SET photos_due = false WHERE merged_into = m.id AND photos_due;
    PERFORM set_config('hermosa.photo_sharing', 'off', true);
  END IF;
  -- A waiting line under an approved sale is approved with it.
  IF m.state = 'APPROVED' THEN
    UPDATE public.service_logs SET state = 'APPROVED', decided_by = v_user, decided_at = now()
    WHERE merged_into = m.id AND state = 'PENDING';
  END IF;
  PERFORM private.audit(m.branch_id, 'SERVICE_LOG_MERGED', 'service_log', x.id::text,
    jsonb_build_object('log_no', x.log_no), jsonb_build_object('into', m.id, 'into_log_no', m.log_no, 'lines', v_n));
  RETURN jsonb_build_object('ok', true, 'id', m.id, 'log_no', m.log_no, 'lines', v_n);
END $$;
REVOKE ALL ON FUNCTION public.merge_service_entry(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.merge_service_entry(uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.separate_service_entry(p_line uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id(); x public.service_logs%ROWTYPE; v_prefix text; v_no text;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  SELECT * INTO x FROM public.service_logs WHERE id = p_line AND organization_id = private.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF NOT (private.has_role(ARRAY['OWNER','MANAGER'], x.branch_id) OR private.is_gm()) THEN RETURN private.deny(x.branch_id, 'service_log.merge'); END IF;
  IF x.merged_into IS NULL THEN RETURN jsonb_build_object('ok', true, 'id', x.id, 'log_no', x.log_no); END IF;
  v_prefix := private.log_prefix(x.service_date);
  PERFORM pg_advisory_xact_lock(hashtext('log_no:' || x.organization_id::text || v_prefix));
  v_no := v_prefix || lpad((coalesce((SELECT max(nullif(split_part(log_no, '-', 3), '')::integer) FROM public.service_logs
      WHERE organization_id = x.organization_id AND log_no LIKE v_prefix || '%'), 0) + 1)::text, 3, '0');
  PERFORM set_config('hermosa.log_merge', 'on', true);
  UPDATE public.service_logs SET merged_into = NULL, log_no = v_no WHERE id = x.id;
  PERFORM set_config('hermosa.log_merge', 'off', true);
  PERFORM private.audit(x.branch_id, 'SERVICE_LOG_SEPARATED', 'service_log', x.id::text,
    jsonb_build_object('into', x.merged_into), jsonb_build_object('log_no', v_no));
  RETURN jsonb_build_object('ok', true, 'id', x.id, 'log_no', v_no);
END $$;
REVOKE ALL ON FUNCTION public.separate_service_entry(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.separate_service_entry(uuid) TO authenticated;

-- Meds and add-ons picked when logging (updates 0069 and 0080) now go under the main sale.
CREATE OR REPLACE FUNCTION public.log_meds(p_log uuid, p_service uuid, p_free boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user uuid := private.current_user_id(); v_org uuid := private.current_org_id();
  l record; v_price bigint; r jsonb; v_id uuid; v_mgmt boolean := private.is_management(private.current_user_id());
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  SELECT * INTO l FROM public.service_logs WHERE id = p_log AND organization_id = v_org;
  IF NOT FOUND OR l.state = 'REJECTED' THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  -- Only whoever saved the visit (or management) adds its meds.
  IF l.created_by <> v_user AND NOT v_mgmt THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_ALLOWED'); END IF;
  SELECT price_cents INTO v_price FROM public.services WHERE id = p_service AND organization_id = v_org AND active AND is_meds;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'UNKNOWN_SERVICE'); END IF;

  r := public.log_visit(l.branch_id, l.service_date, p_service, CASE WHEN coalesce(p_free, false) THEN 0 ELSE v_price END,
    'NONCOMMI', l.performer_id, NULL, NULL, NULL, CASE WHEN coalesce(p_free, false) THEN 'NO_CHARGE' ELSE 'PAID' END, true);
  IF NOT coalesce((r ->> 'ok')::boolean, false) THEN RETURN r; END IF;
  v_id := (r ->> 'id')::uuid;
  -- update-0101: the meds go under the main sale's SL number (one visit, one number).
  UPDATE public.service_logs SET client_name = l.client_name, list_price_cents = v_price, photo_folder = l.photo_folder,
    photos_due = false, session_no = 1, merged_into = coalesce(l.merged_into, l.id), log_no = NULL WHERE id = v_id;
  IF v_mgmt AND r ->> 'state' = 'PENDING' THEN
    UPDATE public.service_logs SET state = 'APPROVED', decided_by = v_user, decided_at = now() WHERE id = v_id AND state = 'PENDING';
    r := r || jsonb_build_object('state', 'APPROVED');
  END IF;
  RETURN r;
END $$;
REVOKE ALL ON FUNCTION public.log_meds(uuid, uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.log_meds(uuid, uuid, boolean) TO authenticated;

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
  -- update-0101: the add-on goes under the main sale's SL number (one visit, one number).
  UPDATE public.service_logs SET client_name = l.client_name, list_price_cents = s.price_cents, photo_folder = l.photo_folder,
    photos_due = false, session_no = 1, merged_into = coalesce(l.merged_into, l.id), log_no = NULL WHERE id = v_id;
  IF v_mgmt AND r ->> 'state' = 'PENDING' THEN
    UPDATE public.service_logs SET state = 'APPROVED', decided_by = v_user, decided_at = now() WHERE id = v_id AND state = 'PENDING';
    r := r || jsonb_build_object('state', 'APPROVED');
  END IF;
  RETURN r;
END $$;
REVOKE ALL ON FUNCTION public.log_addon(uuid, uuid, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.log_addon(uuid, uuid, bigint) TO authenticated;

SELECT 'update-0101 done: meds and add-ons can be merged into the main sale' AS result;
