-- update-0084 (CHRIS Nov 27): payslips showed absences on Nov 23 and 24 for staff who were clearly at work or on their
-- day off. Cause: a scheduled work day with no in-app Time In counted as an absence, but the time clock only started
-- being used on Nov 25. Now a scheduled work day is NOT an absence when:
--   * it is before the time clock start (organizations.payroll_rules.attendance_from, set to 2026-11-25), or
--   * the person did a service that day (Done by or Assisted by on the service log), even without a Time In.
-- Lateness still only comes from a Time In. Draft payslips are recomputed; final ones are not touched.
-- CHECK FIRST (changes nothing):
-- select case when (select payroll_rules ? 'attendance_from' from public.organizations limit 1) then 'ALREADY RUN: tick the box on your To-Do' else 'NOT RUN YET: run the rest of this file' end as result;

UPDATE public.organizations SET payroll_rules = payroll_rules || '{"attendance_from": "2026-11-25"}'
WHERE NOT (payroll_rules ? 'attendance_from');

CREATE OR REPLACE FUNCTION private.compute_payslip(p_run uuid, p_employee uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  r public.payroll_runs%ROWTYPE;
  ps public.pay_settings%ROWTYPE;
  v_today date := (now() AT TIME ZONE 'Asia/Manila')::date;
  v_grace integer;
  v_daily numeric; v_monthly_base bigint;
  d record;
  n_worked integer := 0; n_paid_leave integer := 0; n_unpaid_leave integer := 0; n_absent integer := 0;
  v_late_min integer := 0; v_reg_worked integer := 0; v_spec_worked integer := 0; v_reg_off integer := 0;
  absent_dates text[] := '{}'; unpaid_dates text[] := '{}';
  v_basic bigint; v_abs bigint := 0; v_late bigint := 0; v_hol bigint := 0; v_comm bigint := 0;
  v_comm_list jsonb := '[]'; v_earn jsonb := '[]'; v_ded jsonb := '[]';
  v_sss bigint := 0; v_ph bigint := 0; v_pi bigint := 0; v_tax bigint := 0;
  v_gross bigint; v_dtotal bigint; v_taxable bigint; v_nontax bigint := 0;
  a record; v_first boolean;
  v_csr boolean; v_rules jsonb; v_stat_when text; v_special_premium boolean; v_divisor numeric; v_tax_basic bigint;
  v_att_from date;
BEGIN
  SELECT * INTO r FROM public.payroll_runs WHERE id = p_run;
  SELECT * INTO ps FROM public.pay_settings WHERE employee_id = p_employee;
  IF NOT FOUND THEN DELETE FROM public.payslips WHERE run_id = p_run AND employee_id = p_employee; RETURN; END IF;
  SELECT late_grace_minutes, coalesce(payroll_rules, '{}') INTO v_grace, v_rules FROM public.organizations WHERE id = r.organization_id;
  v_stat_when := coalesce(v_rules ->> 'statutory_cutoff', 'FIRST');
  v_special_premium := coalesce((v_rules ->> 'special_worked_premium')::boolean, true);
  v_divisor := coalesce((v_rules ->> 'daily_divisor')::numeric, 26);
  -- update-0084: the in-app time clock counts from this day; earlier scheduled days are not absences.
  v_att_from := coalesce((v_rules ->> 'attendance_from')::date, date '2026-11-25');
  SELECT upper(coalesce(position, '')) = 'CSR' INTO v_csr FROM public.employees WHERE id = p_employee;
  v_first := extract(day FROM r.period_start) = 1;
  v_daily := CASE ps.basis WHEN 'MONTHLY' THEN ps.rate_cents / v_divisor ELSE ps.rate_cents END;
  -- Government shares (and tax on basic) use the declared salary when one is set.
  v_monthly_base := coalesce(ps.declared_cents, CASE ps.basis WHEN 'MONTHLY' THEN ps.rate_cents ELSE ps.rate_cents * 26 END);

  -- Day by day from the published schedule.
  FOR d IN
    SELECT s.work_date, s.is_off, s.leave_type, s.start_time, h.kind AS hol,
           (SELECT min(t.punched_at) FROM public.time_punches t WHERE t.employee_id = s.employee_id AND t.work_date = s.work_date AND t.kind = 'IN') AS tin,
           private.is_irregular(s.employee_id, s.work_date) AS irregular,
           -- update-0084: did a service that day (Done by or Assisted by), so present even without a Time In.
           EXISTS (SELECT 1 FROM public.service_logs sl WHERE sl.service_date = s.work_date AND sl.state <> 'REJECTED'
                     AND (sl.performer_id = s.employee_id OR sl.assistant_id = s.employee_id)) AS served,
           EXISTS (SELECT 1 FROM public.leave_requests l WHERE l.employee_id = s.employee_id AND l.state = 'APPROVED' AND l.with_pay
                     AND s.work_date BETWEEN l.start_date AND l.end_date) AS paid_leave
    FROM public.shifts s LEFT JOIN public.holidays h ON h.organization_id = s.organization_id AND h.holiday_date = s.work_date
    WHERE s.employee_id = p_employee AND s.state = 'PUBLISHED' AND s.work_date BETWEEN r.period_start AND r.period_end
    ORDER BY s.work_date
  LOOP
    IF d.is_off THEN
      IF d.leave_type IN ('VL','SL') THEN
        IF d.paid_leave THEN n_paid_leave := n_paid_leave + 1;
        ELSE n_unpaid_leave := n_unpaid_leave + 1; unpaid_dates := unpaid_dates || to_char(d.work_date, 'Mon FMDD'); END IF;
      ELSIF d.leave_type = 'ABSENT' AND d.hol IS DISTINCT FROM 'REGULAR' THEN
        n_absent := n_absent + 1; absent_dates := absent_dates || to_char(d.work_date, 'Mon FMDD');
      ELSIF d.hol = 'REGULAR' THEN v_reg_off := v_reg_off + 1;
      END IF;
    ELSIF d.tin IS NOT NULL OR d.served OR d.work_date < v_att_from THEN
      n_worked := n_worked + 1;
      IF d.hol = 'REGULAR' THEN v_reg_worked := v_reg_worked + 1; ELSIF d.hol = 'SPECIAL' THEN v_spec_worked := v_spec_worked + 1; END IF;
      IF d.tin IS NOT NULL AND NOT d.irregular THEN
        v_late_min := v_late_min + greatest(0, floor(extract(epoch FROM ((d.tin AT TIME ZONE 'Asia/Manila') - (d.work_date + d.start_time))) / 60)::int - v_grace);
      END IF;
    ELSIF d.work_date < v_today AND NOT d.irregular THEN
      IF d.hol = 'REGULAR' THEN v_reg_off := v_reg_off + 1;   -- regular holiday not worked: paid, not an absence
      ELSE n_absent := n_absent + 1; absent_dates := absent_dates || to_char(d.work_date, 'Mon FMDD'); END IF;
    END IF;
  END LOOP;

  -- Basic pay.
  IF ps.basis = 'MONTHLY' THEN
    v_basic := CASE WHEN v_first THEN ps.rate_cents / 2 ELSE ps.rate_cents - ps.rate_cents / 2 END;
    v_abs := round(v_daily * (n_absent + n_unpaid_leave));
  ELSE
    v_basic := round(v_daily * (n_worked + n_paid_leave + v_reg_off));
  END IF;
  v_earn := v_earn || jsonb_build_object('label', CASE ps.basis WHEN 'MONTHLY' THEN 'Basic pay (half of monthly salary)'
              ELSE 'Basic pay (' || (n_worked + n_paid_leave + v_reg_off) || ' days)' END, 'amount', v_basic);
  IF v_reg_worked > 0 AND NOT v_csr THEN
    v_hol := v_hol + round(v_daily * v_reg_worked);
    v_earn := v_earn || jsonb_build_object('label', 'Regular holiday worked (+100%, ' || v_reg_worked || ' day' || CASE WHEN v_reg_worked > 1 THEN 's' ELSE '' END || ')', 'amount', round(v_daily * v_reg_worked));
  END IF;
  IF v_spec_worked > 0 AND v_special_premium AND NOT v_csr THEN
    v_hol := v_hol + round(v_daily * 0.3 * v_spec_worked);
    v_earn := v_earn || jsonb_build_object('label', 'Special day worked (+30%, ' || v_spec_worked || ' day' || CASE WHEN v_spec_worked > 1 THEN 's' ELSE '' END || ')', 'amount', round(v_daily * 0.3 * v_spec_worked));
  END IF;

  -- Commissions: signed off, dated up to the cutoff's last day, not paid on an earlier final payslip.
  SELECT coalesce(sum(c.amount_cents), 0),
         coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'date', l.service_date, 'service', sv.name, 'role', c.role,
                    'paid', l.amount_paid_cents, 'amount', c.amount_cents) ORDER BY l.service_date, sv.name), '[]')
    INTO v_comm, v_comm_list
  FROM public.commission_lines c JOIN public.service_logs l ON l.id = c.service_log_id JOIN public.services sv ON sv.id = l.service_id
  WHERE c.employee_id = p_employee AND l.state = 'APPROVED' AND l.service_date <= r.period_end
    AND NOT l.photos_due  -- update-0054: held until the client photos and waiver are added
    AND NOT EXISTS (SELECT 1 FROM public.commission_paid cp WHERE cp.commission_line_id = c.id);
  IF v_comm > 0 THEN v_earn := v_earn || jsonb_build_object('label', 'Commission (' || jsonb_array_length(v_comm_list) || ')', 'amount', v_comm); END IF;
  v_nontax := v_nontax + v_comm;   -- commissions are not taxed (CHRIS Nov 25)
  IF ps.allowance_cents > 0 THEN
    v_earn := v_earn || jsonb_build_object('label', 'Allowance', 'amount', ps.allowance_cents);
    v_nontax := v_nontax + ps.allowance_cents;
  END IF;
  IF ps.cola_cents > 0 AND v_first THEN
    v_earn := v_earn || jsonb_build_object('label', 'COLA', 'amount', ps.cola_cents);
    v_nontax := v_nontax + ps.cola_cents;
  END IF;
  FOR a IN SELECT * FROM public.payslip_adjustments WHERE run_id = p_run AND employee_id = p_employee AND kind = 'EARNING' ORDER BY created_at LOOP
    v_earn := v_earn || jsonb_build_object('label', a.label, 'amount', a.amount_cents, 'adjustment', a.id);
    IF NOT a.taxable THEN v_nontax := v_nontax + a.amount_cents; END IF;
  END LOOP;
  SELECT coalesce(sum((x ->> 'amount')::bigint), 0) INTO v_gross FROM jsonb_array_elements(v_earn) x;

  -- Deductions.
  IF v_abs > 0 THEN
    v_ded := v_ded || jsonb_build_object('label', 'Absences (' || array_to_string(absent_dates || unpaid_dates, ', ') || ')', 'amount', v_abs);
  END IF;
  IF ps.deduct_lates AND v_late_min > 0 THEN
    v_late := round(v_daily / 480.0 * v_late_min);
    IF v_late > 0 THEN v_ded := v_ded || jsonb_build_object('label', 'Lates (' || v_late_min || ' min)', 'amount', v_late); END IF;
  END IF;
  IF ps.statutory AND (v_stat_when = 'SPLIT' OR (v_stat_when = 'FIRST') = v_first) THEN
    v_sss := CASE WHEN v_stat_when <> 'SPLIT' THEN private.sss_ee(v_monthly_base) WHEN v_first THEN private.sss_ee(v_monthly_base) / 2 ELSE private.sss_ee(v_monthly_base) - private.sss_ee(v_monthly_base) / 2 END;
    v_ph := CASE WHEN v_stat_when <> 'SPLIT' THEN private.philhealth_ee(v_monthly_base) WHEN v_first THEN private.philhealth_ee(v_monthly_base) / 2 ELSE private.philhealth_ee(v_monthly_base) - private.philhealth_ee(v_monthly_base) / 2 END;
    v_pi := CASE WHEN v_stat_when <> 'SPLIT' THEN private.pagibig_ee(v_monthly_base) WHEN v_first THEN private.pagibig_ee(v_monthly_base) / 2 ELSE private.pagibig_ee(v_monthly_base) - private.pagibig_ee(v_monthly_base) / 2 END;
    v_ded := v_ded || jsonb_build_object('label', 'SSS premium', 'amount', v_sss)
                   || jsonb_build_object('label', 'PhilHealth', 'amount', v_ph)
                   || jsonb_build_object('label', 'Pag-IBIG fund', 'amount', v_pi);
  END IF;
  IF ps.tax THEN
    -- With a declared salary, tax is on half of it (instead of the actual basic) plus the other taxable pay.
    v_tax_basic := CASE WHEN ps.declared_cents IS NOT NULL THEN ps.declared_cents / 2 ELSE v_basic END;
    v_taxable := greatest(0, v_gross - v_basic + v_tax_basic - v_nontax - v_abs - v_late - v_sss - v_ph - v_pi);
    v_tax := private.wtax_semi(v_taxable);
    IF v_tax > 0 THEN v_ded := v_ded || jsonb_build_object('label', 'Withholding tax', 'amount', v_tax); END IF;
  END IF;
  FOR a IN SELECT * FROM public.payslip_adjustments WHERE run_id = p_run AND employee_id = p_employee AND kind = 'DEDUCTION' ORDER BY created_at LOOP
    v_ded := v_ded || jsonb_build_object('label', a.label, 'amount', a.amount_cents, 'adjustment', a.id);
  END LOOP;
  SELECT coalesce(sum((x ->> 'amount')::bigint), 0) INTO v_dtotal FROM jsonb_array_elements(v_ded) x;

  INSERT INTO public.payslips (run_id, organization_id, employee_id, basis, rate_cents, earnings, deductions, commissions, attendance,
                               gross_cents, deductions_cents, net_cents, computed_at)
  VALUES (p_run, r.organization_id, p_employee, ps.basis, ps.rate_cents, v_earn, v_ded, v_comm_list,
          jsonb_build_object('worked', n_worked, 'paid_leave', n_paid_leave, 'unpaid_leave', n_unpaid_leave, 'absent', n_absent,
                             'late_min', v_late_min, 'daily_rate', round(v_daily)),
          v_gross, v_dtotal, v_gross - v_dtotal, now())
  ON CONFLICT (run_id, employee_id) DO UPDATE SET basis = EXCLUDED.basis, rate_cents = EXCLUDED.rate_cents, earnings = EXCLUDED.earnings,
    deductions = EXCLUDED.deductions, commissions = EXCLUDED.commissions, attendance = EXCLUDED.attendance, gross_cents = EXCLUDED.gross_cents,
    deductions_cents = EXCLUDED.deductions_cents, net_cents = EXCLUDED.net_cents, computed_at = now();
END $$;
REVOKE ALL ON FUNCTION private.compute_payslip(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Recompute every draft payslip with the new rule.
DO $$
DECLARE p record;
BEGIN
  FOR p IN SELECT s.run_id, s.employee_id FROM public.payslips s JOIN public.payroll_runs r ON r.id = s.run_id WHERE r.state = 'DRAFT' LOOP
    PERFORM private.compute_payslip(p.run_id, p.employee_id);
  END LOOP;
END $$;

SELECT 'update-0084 is installed' AS result;
