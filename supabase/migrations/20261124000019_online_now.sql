-- HERMOSA OS 0019: "Online now" for owners and managers (owner request 2026-11-24).
-- Every signed-in person's open app checks in about once a minute while the tab is in view. Owners and
-- managers see who checked in during the last 2 minutes. Only the last check-in time is kept (one row per
-- person), no history. Safe to run more than once.

CREATE TABLE IF NOT EXISTS private.user_presence (
  user_id uuid PRIMARY KEY REFERENCES public.app_users(id) ON DELETE CASCADE,
  last_seen timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON private.user_presence FROM PUBLIC, anon, authenticated;
ALTER TABLE private.user_presence ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.touch_presence() RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  INSERT INTO private.user_presence (user_id, last_seen)
  SELECT u.id, now() FROM public.app_users u
  WHERE u.auth_subject = auth.uid() AND u.active AND coalesce(u.join_status, 'APPROVED') = 'APPROVED'
  ON CONFLICT (user_id) DO UPDATE SET last_seen = now()
$$;

-- Who else is online, for owners and managers (any branch). Others get an empty list.
CREATE OR REPLACE FUNCTION public.online_now() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN private.has_role(ARRAY['OWNER','MANAGER'], NULL)
              OR EXISTS (SELECT 1 FROM public.branches b WHERE b.organization_id = private.current_org_id()
                           AND private.has_role(ARRAY['MANAGER'], b.id))
    THEN coalesce((
      SELECT jsonb_agg(jsonb_build_object('name', x.name, 'last_seen', x.last_seen) ORDER BY x.name)
      FROM (
        SELECT coalesce(nullif(split_part(btrim(e.full_name), ' ', 1), ''), u.display_name) AS name, p.last_seen
        FROM private.user_presence p
        JOIN public.app_users u ON u.id = p.user_id AND u.active
        LEFT JOIN LATERAL (SELECT full_name FROM public.employees e WHERE e.app_user_id = u.id ORDER BY e.active DESC LIMIT 1) e ON true
        WHERE p.last_seen > now() - interval '2 minutes'
          AND u.organization_id = private.current_org_id()
          AND u.id IS DISTINCT FROM private.current_user_id()
      ) x), '[]'::jsonb)
    ELSE '[]'::jsonb END
$$;

REVOKE ALL ON FUNCTION public.touch_presence(), public.online_now() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.touch_presence(), public.online_now() TO authenticated;
