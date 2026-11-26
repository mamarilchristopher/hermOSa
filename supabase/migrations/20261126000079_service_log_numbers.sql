-- update-0079 (CHRIS Nov 26): every service log entry gets a number, SL-YYMM-NNNN (year and month of the SERVICE date,
-- then a running number for that month). New entries get the next number. Once a month's sales are final (e.g. after
-- the old November logs are imported), owners can re-number that month so the numbers run in order of service date,
-- then branch (QC Main, Fairview, Sta. Maria, Marikina), then the time each entry was made.

ALTER TABLE public.service_logs ADD COLUMN IF NOT EXISTS log_no text;
CREATE UNIQUE INDEX IF NOT EXISTS service_logs_log_no ON public.service_logs (organization_id, log_no);

CREATE OR REPLACE FUNCTION private.branch_rank(p_branch uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE b.code WHEN 'QC_MAIN' THEN 1 WHEN 'FAIRVIEW' THEN 2 WHEN 'STA_MARIA' THEN 3 WHEN 'MARIKINA' THEN 4 ELSE 9 END
  FROM public.branches b WHERE b.id = p_branch
$$;
REVOKE ALL ON FUNCTION private.branch_rank(uuid) FROM PUBLIC, anon, authenticated;

-- New entries: the next number in the service month (one at a time per month, so two saves never clash).
CREATE OR REPLACE FUNCTION private.assign_log_no() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_prefix text;
BEGIN
  IF NEW.log_no IS NOT NULL THEN RETURN NEW; END IF;
  v_prefix := 'SL-' || to_char(NEW.service_date, 'YYMM') || '-';
  PERFORM pg_advisory_xact_lock(hashtext('log_no:' || NEW.organization_id::text || v_prefix));
  NEW.log_no := v_prefix || lpad((coalesce((SELECT max(substr(log_no, 9)::integer) FROM public.service_logs
      WHERE organization_id = NEW.organization_id AND log_no LIKE v_prefix || '%'), 0) + 1)::text, 4, '0');
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.assign_log_no() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS assign_log_no ON public.service_logs;
CREATE TRIGGER assign_log_no BEFORE INSERT ON public.service_logs FOR EACH ROW EXECUTE FUNCTION private.assign_log_no();

-- Guard (same as update-0073) plus: re-numbering may change the number only.
CREATE OR REPLACE FUNCTION public.guard_service_logs() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('hermosa.log_delete', true) = 'on' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'SERVICE_LOGS_ARE_NOT_DELETED';
  END IF;
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


-- Numbers a month in order: service date, branch, time entered. Used once now for every month, and by owners after a
-- month's sales are final. Returns how many entries were numbered.
CREATE OR REPLACE FUNCTION private.renumber_month(p_org uuid, p_month date) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_s date := date_trunc('month', p_month)::date; v_prefix text := 'SL-' || to_char(p_month, 'YYMM') || '-'; v_n integer; r record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('log_no:' || p_org::text || v_prefix));
  PERFORM set_config('hermosa.log_renumber', 'on', true);
  -- Clear first so the new order never collides with an old number.
  UPDATE public.service_logs SET log_no = 'TMP-' || id::text
  WHERE organization_id = p_org AND (log_no LIKE v_prefix || '%' OR (service_date >= v_s AND service_date < (v_s + interval '1 month')::date));
  WITH o AS (
    SELECT id, row_number() OVER (ORDER BY service_date, private.branch_rank(branch_id), created_at, id) AS n
    FROM public.service_logs
    WHERE organization_id = p_org AND service_date >= v_s AND service_date < (v_s + interval '1 month')::date
  )
  UPDATE public.service_logs l SET log_no = v_prefix || lpad(o.n::text, 4, '0') FROM o WHERE l.id = o.id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  -- An entry moved out of this month keeps a number in its own month.
  FOR r IN SELECT id, service_date FROM public.service_logs WHERE organization_id = p_org AND log_no LIKE 'TMP-%' ORDER BY service_date, created_at LOOP
    UPDATE public.service_logs SET log_no = 'SL-' || to_char(r.service_date, 'YYMM') || '-' || lpad((coalesce((SELECT max(substr(log_no, 9)::integer)
        FROM public.service_logs WHERE organization_id = p_org AND log_no LIKE 'SL-' || to_char(r.service_date, 'YYMM') || '-%'), 0) + 1)::text, 4, '0')
    WHERE id = r.id;
  END LOOP;
  PERFORM set_config('hermosa.log_renumber', 'off', true);
  RETURN v_n;
END $$;
REVOKE ALL ON FUNCTION private.renumber_month(uuid, date) FROM PUBLIC, anon, authenticated;

-- Owners only (CHRIS): re-number one month once its sales are final. Changes the numbers of that month's entries.
CREATE OR REPLACE FUNCTION public.renumber_service_logs(p_month date) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id(); v_org uuid := private.current_org_id(); v_n integer;
BEGIN
  IF v_user IS NULL OR NOT private.has_role(ARRAY['OWNER'], NULL) THEN RETURN jsonb_build_object('ok', false, 'error', 'FORBIDDEN'); END IF;
  IF p_month IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST'); END IF;
  v_n := private.renumber_month(v_org, p_month);
  PERFORM private.audit(NULL, 'SERVICE_LOGS_RENUMBERED', 'service_logs', to_char(p_month, 'YYYY-MM'), NULL, jsonb_build_object('entries', v_n));
  RETURN jsonb_build_object('ok', true, 'entries', v_n);
END $$;
REVOKE ALL ON FUNCTION public.renumber_service_logs(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.renumber_service_logs(date) TO authenticated;

-- Number every entry made so far, month by month.
DO $$
DECLARE m record;
BEGIN
  FOR m IN SELECT DISTINCT organization_id, date_trunc('month', service_date)::date AS mon FROM public.service_logs ORDER BY 1, 2 LOOP
    PERFORM private.renumber_month(m.organization_id, m.mon);
  END LOOP;
END $$;

-- Proof of payment folders carry the entry number too.
CREATE OR REPLACE FUNCTION public.payment_proof_folders(p_month date, p_branch uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH m AS (SELECT date_trunc('month', coalesce(p_month, (now() AT TIME ZONE 'Asia/Manila')::date))::date AS s)
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'date', l.service_date, 'client', l.client_name, 'service', sv.name,
      'branch_id', l.branch_id, 'branch', b.name, 'amount_cents', l.amount_paid_cents, 'kind', l.visit_kind, 'state', l.state, 'staff', private.first_name(l.created_by), 'log_no', l.log_no,
      'check', (SELECT jsonb_build_object('state', k.state, 'note', k.note, 'by', private.first_name(k.decided_by), 'at', k.decided_at)
                FROM public.payment_checks k LEFT JOIN public.app_users u2 ON u2.id = k.decided_by WHERE k.service_log_id = l.id),
      'proofs', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'path', p.path, 'thumb', p.thumb_path, 'by', u.display_name, 'by_short', private.first_name(p.created_by), 'at', p.created_at)
                   ORDER BY p.created_at), '[]'::jsonb)
                 FROM public.payment_proofs p LEFT JOIN public.app_users u ON u.id = p.created_by WHERE p.service_log_id = l.id))
    ORDER BY l.service_date DESC, lower(coalesce(l.client_name, '')), l.created_at), '[]'::jsonb)
  FROM public.service_logs l CROSS JOIN m
  LEFT JOIN public.services sv ON sv.id = l.service_id
  LEFT JOIN public.branches b ON b.id = l.branch_id
  WHERE l.organization_id = private.current_org_id()
    AND l.service_date >= m.s AND l.service_date < (m.s + interval '1 month')::date
    AND (p_branch IS NULL OR l.branch_id = p_branch)
    AND EXISTS (SELECT 1 FROM public.payment_proofs p WHERE p.service_log_id = l.id)
    AND private.can_see_payment_proof(l.id)
$$;
REVOKE ALL ON FUNCTION public.payment_proof_folders(date, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.payment_proof_folders(date, uuid) TO authenticated;
