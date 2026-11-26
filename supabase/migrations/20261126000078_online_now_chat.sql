-- update-0078 (CHRIS Nov 26): tap someone in "Online now" to chat with them, so the list carries each person's account id.

CREATE OR REPLACE FUNCTION public.online_now() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM public.app_users me WHERE me.id = private.current_user_id() AND me.active
                           AND coalesce(me.join_status, 'APPROVED') = 'APPROVED')
    THEN coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'last_seen', x.last_seen, 'photo', x.photo_path, 'owner', x.owner)
                       ORDER BY x.owner DESC, x.name)
      FROM (
        SELECT coalesce(nullif(btrim(e.nickname), ''),
                        nullif(btrim((SELECT d.data ->> 'nickname' FROM public.employee_details d WHERE d.employee_id = e.id)), ''),
                        nullif(regexp_replace(btrim(e.full_name), '^(?:[Mm][Aa]\.?\s+)?(\S+).*$', '\1'), ''),
                        u.display_name) AS name,
               u.id, p.last_seen, u.photo_path,
               EXISTS (SELECT 1 FROM public.role_grants g WHERE g.user_id = u.id AND g.role_code = 'OWNER' AND g.revoked_at IS NULL) AS owner
        FROM private.user_presence p
        JOIN public.app_users u ON u.id = p.user_id AND u.active
        LEFT JOIN LATERAL (SELECT e.id, e.full_name, e.nickname FROM public.employees e WHERE e.app_user_id = u.id ORDER BY e.active DESC LIMIT 1) e ON true
        WHERE p.last_seen > now() - interval '2 minutes'
          AND u.organization_id = private.current_org_id()
          AND u.id IS DISTINCT FROM private.current_user_id()
      ) x), '[]'::jsonb)
    ELSE '[]'::jsonb END
$$;
REVOKE ALL ON FUNCTION public.online_now() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.online_now() TO authenticated;

-- update-0078 (CHRIS Nov 26): approval notices clear for ALL of management once anyone decides.
-- Each "to approve" notice was written in the same moment (same transaction time) as the request, by the requester,
-- so it is matched exactly by kind + who sent it + that time.
CREATE OR REPLACE FUNCTION private.clear_approval_notices() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF OLD.state IS DISTINCT FROM 'PENDING' OR NEW.state = 'PENDING' THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'profile_photos' THEN
    UPDATE public.notifications SET read_at = now() WHERE read_at IS NULL AND kind = 'PHOTO_SUBMITTED'
      AND created_by = NEW.user_id AND created_at = NEW.submitted_at;
  ELSIF TG_TABLE_NAME = 'leave_requests' THEN
    UPDATE public.notifications SET read_at = now() WHERE read_at IS NULL AND kind = 'LEAVE_FILED'
      AND created_by = NEW.filed_by AND created_at = NEW.filed_at;
  ELSIF TG_TABLE_NAME = 'schedule_requests' THEN
    UPDATE public.notifications SET read_at = now() WHERE read_at IS NULL AND kind = 'SWAP_TO_APPROVE'
      AND created_at = NEW.coworker_at;
  ELSIF TG_TABLE_NAME = 'cola_requests' THEN
    UPDATE public.notifications SET read_at = now() WHERE read_at IS NULL AND kind = 'COLA_REQUEST'
      AND created_by = NEW.requested_by AND created_at = NEW.created_at;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION private.clear_approval_notices() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS clear_approval_notices ON public.profile_photos;
CREATE TRIGGER clear_approval_notices AFTER UPDATE OF state ON public.profile_photos FOR EACH ROW EXECUTE FUNCTION private.clear_approval_notices();
DROP TRIGGER IF EXISTS clear_approval_notices ON public.leave_requests;
CREATE TRIGGER clear_approval_notices AFTER UPDATE OF state ON public.leave_requests FOR EACH ROW EXECUTE FUNCTION private.clear_approval_notices();
DROP TRIGGER IF EXISTS clear_approval_notices ON public.schedule_requests;
CREATE TRIGGER clear_approval_notices AFTER UPDATE OF state ON public.schedule_requests FOR EACH ROW EXECUTE FUNCTION private.clear_approval_notices();
DROP TRIGGER IF EXISTS clear_approval_notices ON public.cola_requests;
CREATE TRIGGER clear_approval_notices AFTER UPDATE OF state ON public.cola_requests FOR EACH ROW EXECUTE FUNCTION private.clear_approval_notices();

-- Clear the ones already decided (e.g. profile pictures approved before this update).
UPDATE public.notifications n SET read_at = now() WHERE n.read_at IS NULL AND n.kind = 'PHOTO_SUBMITTED'
  AND EXISTS (SELECT 1 FROM public.profile_photos p WHERE p.user_id = n.created_by AND p.submitted_at = n.created_at AND p.state <> 'PENDING');
UPDATE public.notifications n SET read_at = now() WHERE n.read_at IS NULL AND n.kind = 'LEAVE_FILED'
  AND EXISTS (SELECT 1 FROM public.leave_requests l WHERE l.filed_by = n.created_by AND l.filed_at = n.created_at AND l.state <> 'PENDING');
UPDATE public.notifications n SET read_at = now() WHERE n.read_at IS NULL AND n.kind = 'SWAP_TO_APPROVE'
  AND EXISTS (SELECT 1 FROM public.schedule_requests s WHERE s.coworker_at = n.created_at AND s.state <> 'PENDING');
UPDATE public.notifications n SET read_at = now() WHERE n.read_at IS NULL AND n.kind = 'COLA_REQUEST'
  AND EXISTS (SELECT 1 FROM public.cola_requests c WHERE c.requested_by = n.created_by AND c.created_at = n.created_at AND c.state <> 'PENDING');

-- update-0078 (CHRIS Nov 26): Proof of payment shows who made the service log entry ("Client - Staff"), and short first names (no "Ma.").
CREATE OR REPLACE FUNCTION public.payment_proof_folders(p_month date, p_branch uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH m AS (SELECT date_trunc('month', coalesce(p_month, (now() AT TIME ZONE 'Asia/Manila')::date))::date AS s)
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'date', l.service_date, 'client', l.client_name, 'service', sv.name,
      'branch_id', l.branch_id, 'branch', b.name, 'amount_cents', l.amount_paid_cents, 'kind', l.visit_kind, 'state', l.state, 'staff', private.first_name(l.created_by),
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
