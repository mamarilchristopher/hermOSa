-- Hermosa OS update-0098 (CHRIS Nov 27): service log numbers follow the service DATE, day first:
--   SL-DDMMYY-NNN, e.g. SL-271126-001 = the first entry of Nov 27, 2026 (the count restarts every day; order within a
--   day = branch (QC Main, Fairview, Sta. Maria, Marikina), then the time it was entered, once the day is re-numbered).
-- Every existing entry is converted. Its old number (e.g. SL-2611-0432) is kept as old_log_no, so search still finds
-- codes already written on waivers, and the old-import placeholder client names (= old numbers) take the new number.
-- Also moves Narie's Nov 27 entries (old SL-2611-0432 to 0437) to QC Main if that fix hasn't run yet.
-- Safe to run again.
-- CHECK FIRST (changes nothing):
-- select case when exists (select 1 from pg_proc where proname = 'log_prefix') then 'ALREADY RUN: tick the box on your To-Do' else 'NOT RUN YET: run the rest of this file' end as result;

ALTER TABLE public.service_logs ADD COLUMN IF NOT EXISTS old_log_no text;
CREATE INDEX IF NOT EXISTS service_logs_old_log_no ON public.service_logs (organization_id, old_log_no);

-- The one place the format lives. SL-DDMMYY- (day, month, year of the service date).
CREATE OR REPLACE FUNCTION private.log_prefix(p_date date) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$ SELECT 'SL-' || to_char(p_date, 'DDMMYY') || '-' $$;
REVOKE ALL ON FUNCTION private.log_prefix(date) FROM PUBLIC, anon, authenticated;

-- New entries: the next number of their service day.
CREATE OR REPLACE FUNCTION private.assign_log_no() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_prefix text;
BEGIN
  IF NEW.log_no IS NOT NULL THEN RETURN NEW; END IF;
  v_prefix := private.log_prefix(NEW.service_date);
  PERFORM pg_advisory_xact_lock(hashtext('log_no:' || NEW.organization_id::text || v_prefix));
  NEW.log_no := v_prefix || lpad((coalesce((SELECT max(nullif(split_part(log_no, '-', 3), '')::integer) FROM public.service_logs
      WHERE organization_id = NEW.organization_id AND log_no LIKE v_prefix || '%'), 0) + 1)::text, 3, '0');
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.assign_log_no() FROM PUBLIC, anon, authenticated;

-- Re-number every day of a month: per day, by branch then time entered. Returns how many entries were numbered.
CREATE OR REPLACE FUNCTION private.renumber_month(p_org uuid, p_month date) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_s date := date_trunc('month', p_month)::date; v_e date := (date_trunc('month', p_month) + interval '1 month')::date;
  v_n integer; r record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('log_no_month:' || p_org::text || to_char(v_s, 'YYYY-MM')));
  PERFORM set_config('hermosa.log_renumber', 'on', true);
  -- Clear first so the new order never collides with an old number (entries of this month, and any still carrying
  -- one of this month's numbers after a date change).
  UPDATE public.service_logs SET log_no = 'TMP-' || id::text
  WHERE organization_id = p_org
    AND ((service_date >= v_s AND service_date < v_e)
         OR EXISTS (SELECT 1 FROM generate_series(v_s, v_e - 1, interval '1 day') d WHERE log_no LIKE private.log_prefix(d::date) || '%'));
  WITH o AS (
    SELECT id, service_date, row_number() OVER (PARTITION BY service_date ORDER BY private.branch_rank(branch_id), created_at, id) AS n
    FROM public.service_logs
    WHERE organization_id = p_org AND service_date >= v_s AND service_date < v_e
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
REVOKE ALL ON FUNCTION private.renumber_month(uuid, date) FROM PUBLIC, anon, authenticated;

-- Sales sources (update-0096): an SL number may be a new one or an old one written before update-0098.
CREATE OR REPLACE FUNCTION public.set_sales_sources(p_rows jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id(); v_org uuid := private.current_org_id(); r jsonb; v_log uuid; v_src text;
  n integer := 0; v_missing jsonb := '[]'::jsonb;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT (private.has_role(ARRAY['OWNER'], NULL) OR private.is_gm()) THEN RETURN private.deny(NULL, 'sales_source'); END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 OR jsonb_array_length(p_rows) > 2000 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
  END IF;
  FOR r IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    IF jsonb_typeof(r) <> 'object' OR (r ->> 'source' IS NOT NULL AND (r ->> 'source') NOT IN ('AD','PAGE','WALK_IN','REFERRAL','RETURNING','OTHER')) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'BAD_SOURCE', 'row', r);
    END IF;
  END LOOP;
  FOR r IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    v_src := r ->> 'source';
    v_log := NULL;
    IF coalesce(r ->> 'log', '') ~ '^[0-9a-fA-F-]{36}$' THEN
      SELECT l.id INTO v_log FROM public.service_logs l WHERE l.id = (r ->> 'log')::uuid AND l.organization_id = v_org;
    ELSIF r ->> 'log_no' IS NOT NULL THEN
      SELECT l.id INTO v_log FROM public.service_logs l WHERE l.organization_id = v_org AND upper(l.log_no) = upper(btrim(r ->> 'log_no'));
      IF v_log IS NULL THEN
        SELECT l.id INTO v_log FROM public.service_logs l WHERE l.organization_id = v_org AND upper(l.old_log_no) = upper(btrim(r ->> 'log_no'));
      END IF;
    END IF;
    IF v_log IS NULL THEN
      v_missing := v_missing || to_jsonb(coalesce(r ->> 'log_no', r ->> 'log', '?'));
      CONTINUE;
    END IF;
    IF v_src IS NULL THEN
      DELETE FROM public.service_log_sources WHERE service_log_id = v_log;
    ELSE
      INSERT INTO public.service_log_sources AS s (service_log_id, organization_id, source, set_by, set_at)
      VALUES (v_log, v_org, v_src, v_user, now())
      ON CONFLICT (service_log_id) DO UPDATE SET source = excluded.source, set_by = excluded.set_by, set_at = now();
    END IF;
    n := n + 1;
  END LOOP;
  IF n > 0 THEN PERFORM private.audit(NULL, 'SALES_SOURCES_SET', 'service_log', NULL, NULL, jsonb_build_object('rows', n)); END IF;
  RETURN jsonb_build_object('ok', true, 'saved', n, 'missing', v_missing);
END $$;
REVOKE ALL ON FUNCTION public.set_sales_sources(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_sales_sources(jsonb) TO authenticated;

-- One-time conversion (skipped when every entry already has the new format).
DO $$
DECLARE v_qc uuid; x record; m record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.service_logs WHERE log_no ~ '^SL-\d{4}-\d{4}$') THEN RETURN; END IF;

  -- Narie, Nov 27 (CHRIS): timed in at QC Main, logged under Sta. Maria. Same as setup/fix-nov27-narie-branch.sql.
  SELECT id INTO v_qc FROM public.branches WHERE code = 'QC_MAIN' AND kind = 'CLINIC';
  PERFORM set_config('hermosa.log_rebranch', 'on', true);
  FOR x IN SELECT id, branch_id FROM public.service_logs
           WHERE log_no IN ('SL-2611-0432','SL-2611-0433','SL-2611-0434','SL-2611-0435','SL-2611-0436','SL-2611-0437')
             AND service_date = date '2026-11-27' AND v_qc IS NOT NULL AND branch_id <> v_qc
  LOOP
    UPDATE public.service_logs SET branch_id = v_qc WHERE id = x.id;
    UPDATE public.service_photos SET branch_id = v_qc WHERE service_log_id = x.id;
    PERFORM private.audit(v_qc, 'SERVICE_LOG_REBRANCHED', 'service_log', x.id::text,
      jsonb_build_object('branch', x.branch_id), jsonb_build_object('branch', v_qc, 'why', 'timed in at QC Main'));
  END LOOP;
  PERFORM set_config('hermosa.log_rebranch', 'off', true);

  -- Keep the old numbers (the guard allows only number changes under log_renumber, so this step runs unguarded).
  ALTER TABLE public.service_logs DISABLE TRIGGER service_logs_guard;
  UPDATE public.service_logs SET old_log_no = log_no WHERE old_log_no IS NULL AND log_no ~ '^SL-\d{4}-\d{4}$';
  ALTER TABLE public.service_logs ENABLE TRIGGER service_logs_guard;

  -- New numbers, month by month.
  FOR m IN SELECT DISTINCT organization_id, date_trunc('month', service_date)::date AS mon FROM public.service_logs ORDER BY 2 LOOP
    PERFORM private.renumber_month(m.organization_id, m.mon);
  END LOOP;

  -- Placeholder client names that were the old number take the new number.
  PERFORM set_config('hermosa.booking_link', 'on', true);
  UPDATE public.service_logs SET client_name = log_no WHERE old_log_no IS NOT NULL AND client_name = old_log_no;
  PERFORM set_config('hermosa.booking_link', 'off', true);

  PERFORM private.audit(NULL, 'SERVICE_LOGS_RENUMBERED', 'service_logs', 'SL-DDMMYY-NNN', NULL,
    jsonb_build_object('entries', (SELECT count(*) FROM public.service_logs WHERE old_log_no IS NOT NULL)));
END $$;

-- Shows a few converted numbers: new code, old code, date.
SELECT log_no AS new_code, old_log_no AS old_code, service_date FROM public.service_logs
ORDER BY service_date DESC, log_no LIMIT 12;
