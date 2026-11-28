-- update-0105 (CHRIS Nov 28, v0.105.0): every package session paid ₱0 earns its session commission.
--   A session of a package or bundle the client already paid for (or a free session) is logged as Paid ₱0. Under the
--   current rule it pays the package's set session commission (e.g. Lux Queen 10+3 ₱80, VContour 5+1 ₱62.50), split
--   60/40 between Done by and Assisted by, each double-dose session counted on its own. This is what "Fully paid
--   package" does since v0.103.2.
--   private.fix_zero_package_commissions re-works the commission of EVERY past Paid ₱0 session of a package to that
--   rule: missing or ₱0 commission is filled in, a session saved with no commission (e.g. ₱0 on the old paper log)
--   gets it. Only staff on commission get a share. Never touches rejected entries, meds, priced services, or anything
--   already on a FINAL payslip (those are listed instead). p_apply = false only shows what would change.
--   Safe to run again: entries already right are left alone.

CREATE OR REPLACE FUNCTION private.fix_zero_package_commissions(p_apply boolean)
RETURNS TABLE (staff text, sl_no text, service_date date, branch text, service text, session_no integer,
               before_cents bigint, after_cents bigint, result text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  l record; v_lead_ok boolean; v_asst_ok boolean; v_lead_c bigint; v_type text; v_exp jsonb; v_now jsonb;
  v_locked boolean; v_result text; e record;
BEGIN
  FOR l IN
    SELECT sl.id, sl.log_no, sl.service_date, sl.branch_id, b.name AS branch_name, s.name AS service_name, sl.session_no,
           sl.commission_type, sl.performer_id, sl.assistant_id, coalesce(sl.lead_share_bp, 6000) AS share, s.commission_cents AS fixed
    FROM public.service_logs sl
    JOIN public.services s ON s.id = sl.service_id
    JOIN public.branches b ON b.id = sl.branch_id
    WHERE coalesce(sl.visit_kind, 'PAID') = 'PAID' AND sl.amount_paid_cents = 0 AND sl.state <> 'REJECTED'
      AND NOT coalesce(s.is_meds, false)
      -- a package or bundle (it has sessions), or a service priced ₱0 with a set session commission
      AND (coalesce(cardinality(s.session_prices), 0) > 0 OR (coalesce(s.price_cents, 0) = 0 AND coalesce(s.commission_cents, 0) > 0))
    ORDER BY sl.service_date, private.branch_rank(sl.branch_id), sl.log_no
  LOOP
    -- What is saved now: employee -> amount.
    SELECT coalesce(jsonb_object_agg(c.employee_id::text, c.amount_cents), '{}'::jsonb) INTO v_now
    FROM public.commission_lines c WHERE c.service_log_id = l.id;

    IF l.fixed IS NULL THEN
      -- A package with no set session commission: nothing to go by. Listed so it can be set in the price list.
      IF v_now = '{}'::jsonb OR NOT EXISTS (SELECT 1 FROM jsonb_each(v_now) x WHERE (x.value)::bigint > 0) THEN
        RETURN QUERY SELECT (SELECT full_name FROM public.employees WHERE id = l.performer_id), l.log_no, l.service_date, l.branch_name,
          l.service_name, l.session_no, 0::bigint, 0::bigint, 'NOT CHANGED: this package has no set session commission in the price list'::text;
      END IF;
      CONTINUE;
    END IF;

    -- What the rule says: the set commission, 60/40 with an assistant, only for staff on commission.
    SELECT commission_eligible INTO v_lead_ok FROM public.employees WHERE id = l.performer_id;
    v_asst_ok := false;
    IF l.assistant_id IS NOT NULL AND l.assistant_id <> l.performer_id THEN
      SELECT commission_eligible INTO v_asst_ok FROM public.employees WHERE id = l.assistant_id;
      v_type := 'LEAD';
      v_lead_c := (l.fixed * l.share + 5000) / 10000;
      v_exp := '{}'::jsonb;
      IF coalesce(v_lead_ok, false) THEN v_exp := v_exp || jsonb_build_object(l.performer_id::text, v_lead_c); END IF;
      IF coalesce(v_asst_ok, false) THEN v_exp := v_exp || jsonb_build_object(l.assistant_id::text, l.fixed - v_lead_c); END IF;
    ELSE
      v_type := 'SOLO';
      v_exp := CASE WHEN coalesce(v_lead_ok, false) THEN jsonb_build_object(l.performer_id::text, l.fixed) ELSE '{}'::jsonb END;
    END IF;

    IF v_exp = v_now THEN CONTINUE; END IF;  -- already right

    v_locked := EXISTS (SELECT 1 FROM public.commission_paid cp JOIN public.commission_lines c ON c.id = cp.commission_line_id
                        WHERE c.service_log_id = l.id);
    v_result := CASE WHEN v_locked THEN 'NOT CHANGED: already on a final payslip'
                     WHEN p_apply THEN 'FIXED' ELSE 'WOULD BE FIXED (preview only)' END;

    IF p_apply AND NOT v_locked THEN
      PERFORM set_config('hermosa.log_delete', 'on', true);
      DELETE FROM public.commission_lines WHERE service_log_id = l.id;
      PERFORM set_config('hermosa.log_delete', 'off', true);
      IF v_type = 'LEAD' THEN
        IF coalesce(v_lead_ok, false) THEN
          INSERT INTO public.commission_lines (service_log_id, employee_id, role, amount_cents) VALUES (l.id, l.performer_id, 'LEAD', v_lead_c);
        END IF;
        IF coalesce(v_asst_ok, false) THEN
          INSERT INTO public.commission_lines (service_log_id, employee_id, role, amount_cents) VALUES (l.id, l.assistant_id, 'ASSIST', l.fixed - v_lead_c);
        END IF;
      ELSIF coalesce(v_lead_ok, false) THEN
        INSERT INTO public.commission_lines (service_log_id, employee_id, role, amount_cents) VALUES (l.id, l.performer_id, 'SOLO', l.fixed);
      END IF;
      -- An entry saved as "no commission" (e.g. ₱0 on the old paper log) now pays: mark its split.
      IF v_exp <> '{}'::jsonb AND l.commission_type IS DISTINCT FROM v_type THEN
        PERFORM set_config('hermosa.log_fix', 'on', true);
        UPDATE public.service_logs SET commission_type = v_type WHERE id = l.id;
        PERFORM set_config('hermosa.log_fix', 'off', true);
      END IF;
      PERFORM private.audit(l.branch_id, 'COMMISSION_PACKAGE_SESSION_RECALC', 'service_log', l.id::text,
        jsonb_build_object('commission', v_now, 'type', l.commission_type), jsonb_build_object('commission', v_exp, 'type', v_type));
    END IF;

    -- One row per person whose commission changes on this entry.
    FOR e IN SELECT k AS emp FROM (SELECT jsonb_object_keys(v_now) AS k UNION SELECT jsonb_object_keys(v_exp)) z LOOP
      IF coalesce((v_now ->> e.emp)::bigint, 0) IS DISTINCT FROM coalesce((v_exp ->> e.emp)::bigint, 0) THEN
        RETURN QUERY SELECT (SELECT full_name FROM public.employees WHERE id = e.emp::uuid), l.log_no, l.service_date, l.branch_name,
          l.service_name, l.session_no, coalesce((v_now ->> e.emp)::bigint, 0), coalesce((v_exp ->> e.emp)::bigint, 0), v_result;
      END IF;
    END LOOP;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION private.fix_zero_package_commissions(boolean) FROM PUBLIC, anon, authenticated;

-- Run it and show the result: one line per person per entry, then each person's TOTAL change (₱, fixed entries only).
-- To only look first, change true to false on the next line: nothing is saved then.
WITH r AS (SELECT * FROM private.fix_zero_package_commissions(true))
SELECT coalesce(staff, '(no one on commission)') AS staff,
       CASE WHEN GROUPING(sl_no) = 1 THEN 'TOTAL' ELSE sl_no END AS sl_no,
       CASE WHEN GROUPING(sl_no) = 0 THEN max(service_date) END AS date, CASE WHEN GROUPING(sl_no) = 0 THEN max(branch) END AS branch,
       CASE WHEN GROUPING(sl_no) = 0 THEN max(service) END AS service, CASE WHEN GROUPING(sl_no) = 0 THEN max(session_no) END AS session,
       (sum(before_cents) / 100.0)::numeric(12,2) AS commission_before, (sum(after_cents) / 100.0)::numeric(12,2) AS commission_after,
       (sum(after_cents - before_cents) FILTER (WHERE result NOT LIKE 'NOT CHANGED%') / 100.0)::numeric(12,2) AS change,
       CASE WHEN GROUPING(sl_no) = 0 THEN max(result) END AS result
FROM r
GROUP BY GROUPING SETS ((staff, sl_no), (staff))
ORDER BY staff, GROUPING(sl_no), min(service_date), sl_no;
