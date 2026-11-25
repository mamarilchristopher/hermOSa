-- update-0057: every employee can view and download the Client archive and Social media folders;
-- only management (owners and the GM) can delete a client folder (the visit, its commission lines and its photos).

-- Anyone with an active role can open both photo tabs (CHRIS Nov 26).
CREATE OR REPLACE FUNCTION private.can_see_archive(p_branch uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.role_grants g WHERE g.user_id = private.current_user_id() AND g.revoked_at IS NULL)
$$;
CREATE OR REPLACE FUNCTION private.can_see_social() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.role_grants g WHERE g.user_id = private.current_user_id() AND g.revoked_at IS NULL)
$$;

-- Service log entries stay undeletable, except through delete_client_visit below.
CREATE OR REPLACE FUNCTION public.guard_service_logs() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('hermosa.log_delete', true) = 'on' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'SERVICE_LOGS_ARE_NOT_DELETED';
  END IF;
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
  RAISE EXCEPTION 'COMMISSION_LINES_ARE_IMMUTABLE';
END $$;

-- Management only: delete one client folder. Returns the photo files for the app to remove from storage.
CREATE OR REPLACE FUNCTION public.delete_client_visit(p_log uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE l public.service_logs; v_paths text[];
BEGIN
  IF NOT private.is_management(private.current_user_id()) THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_ALLOWED'); END IF;
  SELECT * INTO l FROM public.service_logs WHERE id = p_log AND organization_id = private.current_org_id();
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); END IF;
  IF EXISTS (SELECT 1 FROM public.commission_paid cp JOIN public.commission_lines c ON c.id = cp.commission_line_id WHERE c.service_log_id = p_log) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ALREADY_PAID');
  END IF;
  SELECT coalesce(array_agg(x) FILTER (WHERE x IS NOT NULL), '{}') INTO v_paths
  FROM public.service_photos p, LATERAL unnest(ARRAY[p.path, p.thumb_path]) x WHERE p.service_log_id = p_log;
  PERFORM set_config('hermosa.log_delete', 'on', true);
  DELETE FROM public.notifications WHERE kind = 'PHOTOS_DUE' AND link LIKE '%&entry=' || p_log::text;
  DELETE FROM public.service_photos WHERE service_log_id = p_log;
  DELETE FROM public.commission_lines WHERE service_log_id = p_log;
  DELETE FROM public.service_logs WHERE id = p_log;
  PERFORM set_config('hermosa.log_delete', 'off', true);
  PERFORM private.audit(l.branch_id, 'service_log.delete', 'service_log', p_log::text,
    jsonb_build_object('date', l.service_date, 'client', l.client_name, 'service_id', l.service_id, 'amount_cents', l.amount_paid_cents), NULL);
  RETURN jsonb_build_object('ok', true, 'paths', to_jsonb(v_paths));
END $$;
REVOKE ALL ON FUNCTION public.delete_client_visit(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_client_visit(uuid) TO authenticated;

-- Management can remove files from the private photo folder.
DO $$
BEGIN
  IF to_regclass('storage.objects') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS client_photos_delete ON storage.objects';
    EXECUTE $p$CREATE POLICY client_photos_delete ON storage.objects FOR DELETE TO authenticated
      USING (bucket_id = 'client-photos' AND private.is_management(private.current_user_id()))$p$;
  END IF;
END $$;
