-- update-0059: "Online now" shows each person's approved nickname (CHRIS Nov 26).
-- Order: the nickname set by management, else the nickname from their approved employee details,
-- else the first name (skipping a "Ma." prefix), else the account name.
CREATE OR REPLACE FUNCTION public.online_now() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM public.app_users me WHERE me.id = private.current_user_id() AND me.active
                           AND coalesce(me.join_status, 'APPROVED') = 'APPROVED')
    THEN coalesce((
      SELECT jsonb_agg(jsonb_build_object('name', x.name, 'last_seen', x.last_seen, 'photo', x.photo_path, 'owner', x.owner)
                       ORDER BY x.owner DESC, x.name)
      FROM (
        SELECT coalesce(nullif(btrim(e.nickname), ''),
                        nullif(btrim((SELECT d.data ->> 'nickname' FROM public.employee_details d WHERE d.employee_id = e.id)), ''),
                        nullif(regexp_replace(btrim(e.full_name), '^(?:[Mm][Aa]\.?\s+)?(\S+).*$', '\1'), ''),
                        u.display_name) AS name,
               p.last_seen, u.photo_path,
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
