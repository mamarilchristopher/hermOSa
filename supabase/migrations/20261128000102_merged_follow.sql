-- update-0102 (CHRIS Nov 28: "once merged, all changes should apply to the merged values"). Lines merged under a main sale
-- (meds, add-ons, other services of the same visit) now move with it: changing the branch or the date of a visit moves
-- every line of that visit, and fixing the client name fixes them all. Asked on any line of a visit, the change applies
-- to the whole visit. A one-time repair puts every merged line back on its main sale's branch and date.

-- 1. Branch: the whole visit moves. Owners and the GM only; not once any of its commission is on a final payslip.
CREATE OR REPLACE FUNCTION public.change_service_branch(p_log uuid, p_branch uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE l public.service_logs%ROWTYPE; v_user uuid := private.current_user_id(); x record; v_n integer := 0;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  SELECT * INTO l FROM public.service_logs WHERE id = p_log AND organization_id = private.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF l.merged_into IS NOT NULL THEN -- a merged line: act on its main sale (the whole visit)
    SELECT * INTO l FROM public.service_logs WHERE id = l.merged_into FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  END IF;
  IF NOT (private.has_role(ARRAY['OWNER'], NULL) OR private.is_gm()) THEN RETURN private.deny(l.branch_id, 'service_log'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches b WHERE b.id = p_branch AND b.organization_id = l.organization_id AND b.kind = 'CLINIC' AND b.active) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.service_logs WHERE (id = l.id OR merged_into = l.id) AND branch_id IS DISTINCT FROM p_branch) THEN
    RETURN jsonb_build_object('ok', true, 'id', l.id, 'moved', 0);
  END IF;
  IF EXISTS (SELECT 1 FROM public.commission_paid cp JOIN public.commission_lines c ON c.id = cp.commission_line_id
             JOIN public.service_logs s ON s.id = c.service_log_id WHERE s.id = l.id OR s.merged_into = l.id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ALREADY_PAID');
  END IF;
  PERFORM set_config('hermosa.log_rebranch', 'on', true);
  FOR x IN SELECT id, branch_id FROM public.service_logs WHERE (id = l.id OR merged_into = l.id) AND branch_id IS DISTINCT FROM p_branch ORDER BY created_at LOOP
    UPDATE public.service_logs SET branch_id = p_branch WHERE id = x.id;
    UPDATE public.service_photos SET branch_id = p_branch WHERE service_log_id = x.id;
    PERFORM private.audit(p_branch, 'SERVICE_LOG_REBRANCHED', 'service_log', x.id::text,
      jsonb_build_object('branch', x.branch_id), jsonb_build_object('branch', p_branch, 'visit', l.id));
    v_n := v_n + 1;
  END LOOP;
  PERFORM set_config('hermosa.log_rebranch', 'off', true);
  RETURN jsonb_build_object('ok', true, 'id', l.id, 'moved', v_n);
END $$;
REVOKE ALL ON FUNCTION public.change_service_branch(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.change_service_branch(uuid, uuid) TO authenticated;

-- 2. Date: the whole visit moves.
CREATE OR REPLACE FUNCTION public.change_service_date(p_log uuid, p_date date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE l public.service_logs; v_user uuid := private.current_user_id(); x record; v_n integer := 0;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  SELECT * INTO l FROM public.service_logs WHERE id = p_log AND organization_id = private.current_org_id() FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF l.merged_into IS NOT NULL THEN
    SELECT * INTO l FROM public.service_logs WHERE id = l.merged_into FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  END IF;
  IF NOT private.is_management(v_user) OR NOT private.has_role(ARRAY['OWNER','MANAGER'], l.branch_id) THEN
    RETURN private.deny(l.branch_id, 'service_log');
  END IF;
  IF p_date IS NULL OR p_date > (now() AT TIME ZONE 'Asia/Manila')::date OR p_date < date '2024-01-01' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_DATE');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.service_logs WHERE (id = l.id OR merged_into = l.id) AND service_date IS DISTINCT FROM p_date) THEN
    RETURN jsonb_build_object('ok', true, 'id', l.id, 'moved', 0);
  END IF;
  IF EXISTS (SELECT 1 FROM public.commission_paid cp JOIN public.commission_lines c ON c.id = cp.commission_line_id
             JOIN public.service_logs s ON s.id = c.service_log_id WHERE s.id = l.id OR s.merged_into = l.id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ALREADY_PAID');
  END IF;
  PERFORM set_config('hermosa.log_redate', 'on', true);
  FOR x IN SELECT id, service_date, branch_id FROM public.service_logs WHERE (id = l.id OR merged_into = l.id) AND service_date IS DISTINCT FROM p_date ORDER BY created_at LOOP
    UPDATE public.service_logs SET service_date = p_date WHERE id = x.id;
    PERFORM private.audit(x.branch_id, 'SERVICE_LOG_REDATED', 'service_log', x.id::text,
      jsonb_build_object('date', x.service_date), jsonb_build_object('date', p_date, 'visit', l.id));
    v_n := v_n + 1;
  END LOOP;
  PERFORM set_config('hermosa.log_redate', 'off', true);
  RETURN jsonb_build_object('ok', true, 'id', l.id, 'moved', v_n);
END $$;
REVOKE ALL ON FUNCTION public.change_service_date(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.change_service_date(uuid, date) TO authenticated;

-- 3. Client name: fixing one line of a visit fixes the whole visit (management can still fix every entry with the name).
CREATE OR REPLACE FUNCTION public.rename_service_client(p_log uuid, p_name text, p_all boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id(); l public.service_logs%ROWTYPE; v_name text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  v_mgmt boolean := private.is_management(private.current_user_id()); v_n integer := 0; x record; v_main uuid;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  SELECT * INTO l FROM public.service_logs WHERE id = p_log AND organization_id = private.current_org_id();
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF NOT (v_mgmt OR l.created_by = v_user
          OR EXISTS (SELECT 1 FROM public.employees e WHERE e.id IN (l.performer_id, l.assistant_id) AND e.app_user_id = v_user)) THEN
    RETURN private.deny(l.branch_id, 'service_log');
  END IF;
  IF length(v_name) < 2 OR length(v_name) > 120 THEN RETURN jsonb_build_object('ok', false, 'error', 'CLIENT_NAME_REQUIRED'); END IF;
  IF coalesce(p_all, false) AND NOT v_mgmt THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_ALLOWED'); END IF;
  v_main := coalesce(l.merged_into, l.id);
  PERFORM set_config('hermosa.booking_link', 'on', true); -- the guard lets this change the client name only
  FOR x IN SELECT id, branch_id, client_name FROM public.service_logs
            WHERE organization_id = l.organization_id
              AND (id = v_main OR merged_into = v_main
                   OR (coalesce(p_all, false) AND l.client_name IS NOT NULL AND lower(btrim(client_name)) = lower(btrim(l.client_name))))
              AND client_name IS DISTINCT FROM v_name
  LOOP
    UPDATE public.service_logs SET client_name = v_name WHERE id = x.id;
    PERFORM private.audit(x.branch_id, 'SERVICE_LOG_CLIENT_RENAMED', 'service_log', x.id::text,
      jsonb_build_object('client', x.client_name), jsonb_build_object('client', v_name));
    v_n := v_n + 1;
  END LOOP;
  PERFORM set_config('hermosa.booking_link', 'off', true);
  RETURN jsonb_build_object('ok', true, 'changed', v_n);
END $$;
REVOKE ALL ON FUNCTION public.rename_service_client(uuid, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rename_service_client(uuid, text, boolean) TO authenticated;

-- 4. One-time repair: merged lines left behind when their main sale was moved go back with it (branch, then date).
DO $$
DECLARE x record;
BEGIN
  PERFORM set_config('hermosa.log_rebranch', 'on', true);
  FOR x IN SELECT k.id, k.branch_id AS old_b, m.branch_id AS new_b FROM public.service_logs k JOIN public.service_logs m ON m.id = k.merged_into
            WHERE k.branch_id IS DISTINCT FROM m.branch_id AND m.branch_id IS NOT NULL LOOP
    UPDATE public.service_logs SET branch_id = x.new_b WHERE id = x.id;
    UPDATE public.service_photos SET branch_id = x.new_b WHERE service_log_id = x.id;
    PERFORM private.audit(x.new_b, 'SERVICE_LOG_REBRANCHED', 'service_log', x.id::text,
      jsonb_build_object('branch', x.old_b), jsonb_build_object('branch', x.new_b, 'repair', 'update-0102'));
  END LOOP;
  PERFORM set_config('hermosa.log_rebranch', 'off', true);
  PERFORM set_config('hermosa.log_redate', 'on', true);
  FOR x IN SELECT k.id, k.branch_id, k.service_date AS old_d, m.service_date AS new_d FROM public.service_logs k JOIN public.service_logs m ON m.id = k.merged_into
            WHERE k.service_date IS DISTINCT FROM m.service_date LOOP
    UPDATE public.service_logs SET service_date = x.new_d WHERE id = x.id;
    PERFORM private.audit(x.branch_id, 'SERVICE_LOG_REDATED', 'service_log', x.id::text,
      jsonb_build_object('date', x.old_d), jsonb_build_object('date', x.new_d, 'repair', 'update-0102'));
  END LOOP;
  PERFORM set_config('hermosa.log_redate', 'off', true);
END $$;
