-- update-0077 (CHRIS Nov 26): only CMAs (CMA and Senior CMA, by job title) get 13th month pay.
-- The General Manager, owners, trainees, CSRs and anyone else are left out.

CREATE OR REPLACE FUNCTION public.thirteenth_month(p_year integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_org uuid := private.current_org_id(); v_y0 date; v_y1 date;
BEGIN
  IF NOT private.can_payroll() THEN RETURN '[]'::jsonb; END IF;
  v_y0 := make_date(p_year, 1, 1); v_y1 := make_date(p_year, 12, 31);
  RETURN coalesce((SELECT jsonb_agg(x ORDER BY x ->> 'name') FROM (
    SELECT jsonb_build_object('employee_id', e.id, 'name', e.full_name, 'uid', e.uid, 'hire_date', e.hire_date,
      'monthly', m.monthly, 'months', round(m.months, 2), 'prorated', m.prorated, 'absences', m.absences,
      'amount', greatest(0, round((m.monthly * m.months - m.absences) / 12.0))::bigint) AS x
    FROM public.employees e JOIN public.pay_settings ps ON ps.employee_id = e.id
    CROSS JOIN LATERAL (SELECT
      CASE ps.basis WHEN 'MONTHLY' THEN ps.rate_cents ELSE ps.rate_cents * 26 END AS monthly,
      CASE WHEN e.hire_date IS NOT NULL AND e.hire_date > v_y0 THEN greatest(0, (v_y1 - e.hire_date + 1)) * 12.0 / (v_y1 - v_y0 + 1) ELSE 12 END AS months,
      (e.hire_date IS NOT NULL AND e.hire_date > v_y0) AS prorated,
      coalesce((SELECT sum((d ->> 'amount')::bigint) FROM public.payslips p JOIN public.payroll_runs r ON r.id = p.run_id,
                  jsonb_array_elements(p.deductions) d
                WHERE p.employee_id = e.id AND r.state = 'FINAL' AND extract(year FROM r.period_start) = p_year
                  AND d ->> 'label' LIKE 'Absences%'), 0) AS absences) m
    WHERE e.organization_id = v_org AND e.active AND coalesce(e.position, '') ~* 'cma' -- CMAs only (CHRIS Nov 26)
      AND (e.hire_date IS NULL OR e.hire_date <= v_y1)) q), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION public.thirteenth_month(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.thirteenth_month(integer) TO authenticated;
