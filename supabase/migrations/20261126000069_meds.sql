-- update-0069 (CHRIS Nov 26): Meds on the Service log as their own dropdown, sold with a service.
--   Meds package (Mupirocin + Clindamycin) ₱800, Mupirocin ₱300, Clindamycin ₱500, or the package given free.
--   Meds pay no commission. Each pick is saved as its own line of the same visit (same client, date and staff),
--   so it counts in the day's sales; a free package is a ₱0 "No charge" line.
ALTER TABLE public.services ADD COLUMN IF NOT EXISTS is_meds boolean NOT NULL DEFAULT false;

WITH list(name, price_cents) AS (VALUES
    ('Meds Package (Mupirocin + Clindamycin)', 80000::bigint),
    ('Mupirocin', 30000::bigint),
    ('Clindamycin', 50000::bigint)
), org AS (
  SELECT o.id AS org_id, (SELECT g.user_id FROM public.role_grants g JOIN public.app_users u ON u.id = g.user_id
                           WHERE u.organization_id = o.id AND g.role_code = 'OWNER' AND g.revoked_at IS NULL ORDER BY g.created_at LIMIT 1) AS owner_id
  FROM public.organizations o
)
INSERT INTO public.services (organization_id, name, price_cents, commission_cents, is_meds, created_by, updated_at)
SELECT org.org_id, l.name, l.price_cents, 0, true, org.owner_id, now()
FROM list l CROSS JOIN org WHERE org.owner_id IS NOT NULL
ON CONFLICT (organization_id, lower(btrim(name))) DO UPDATE SET price_cents = EXCLUDED.price_cents, commission_cents = 0,
  is_meds = true, active = true, updated_at = now();

-- Add meds to a visit just saved. p_log = the service line they go with; p_free = the package was given free.
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
  UPDATE public.service_logs SET client_name = l.client_name, list_price_cents = v_price, photo_folder = l.photo_folder,
    photos_due = false, session_no = 1 WHERE id = v_id;
  IF v_mgmt AND r ->> 'state' = 'PENDING' THEN
    UPDATE public.service_logs SET state = 'APPROVED', decided_by = v_user, decided_at = now() WHERE id = v_id AND state = 'PENDING';
    r := r || jsonb_build_object('state', 'APPROVED');
  END IF;
  RETURN r;
END $$;
REVOKE ALL ON FUNCTION public.log_meds(uuid, uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.log_meds(uuid, uuid, boolean) TO authenticated;
