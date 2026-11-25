-- update-0055: Hermosapp phone notifications (CHRIS, Nov 26, 2026).
--   * Each phone or computer that turns on notifications is saved here (only its push address, no personal data).
--   * New notices (approvals, urgent photo reminders, NTEs, ...) and new chat messages are pushed to the person's phones.
--     Chat pushes go only to that chat's members (never the sender) and are shown only on their own device.
--   * The database hands each push to the app (https://hermosaos.com/api/push) with a shared secret; the app encrypts it
--     and sends it through Apple / Google. The secret is created here; the owner copies it into Cloudflare once.

DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_net;
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'pg_net not available here; pushes are skipped';
END $$;

CREATE TABLE IF NOT EXISTS private.app_settings (key text PRIMARY KEY, value text NOT NULL);
REVOKE ALL ON private.app_settings FROM PUBLIC, anon, authenticated;
INSERT INTO private.app_settings (key, value) VALUES ('push_secret', encode(extensions.gen_random_bytes(24), 'hex')) ON CONFLICT (key) DO NOTHING;
INSERT INTO private.app_settings (key, value) VALUES ('push_url', 'https://hermosaos.com/api/push') ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE CHECK (endpoint ~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?/' AND length(endpoint) <= 1000),
  p256dh text NOT NULL CHECK (p256dh ~ '^[A-Za-z0-9_-]{80,100}$'),
  auth text NOT NULL CHECK (auth ~ '^[A-Za-z0-9_-]{16,32}$'),
  device text CHECK (device IS NULL OR length(device) <= 120),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user ON public.push_subscriptions (user_id);
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.push_subscriptions FROM PUBLIC, anon, authenticated;

-- Turn notifications on / off for this device.
CREATE OR REPLACE FUNCTION public.push_subscribe(p_endpoint text, p_p256dh text, p_auth text, p_device text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id();
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF coalesce(p_endpoint, '') !~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?/' OR length(p_endpoint) > 1000
     OR coalesce(p_p256dh, '') !~ '^[A-Za-z0-9_-]{80,100}$' OR coalesce(p_auth, '') !~ '^[A-Za-z0-9_-]{16,32}$' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
  END IF;
  INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth, device) VALUES (v_user, p_endpoint, p_p256dh, p_auth, left(p_device, 120))
  ON CONFLICT (endpoint) DO UPDATE SET user_id = v_user, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, device = EXCLUDED.device, created_at = now();
  RETURN jsonb_build_object('ok', true);
END $$;
CREATE OR REPLACE FUNCTION public.push_unsubscribe(p_endpoint text) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  WITH d AS (DELETE FROM public.push_subscriptions WHERE endpoint = p_endpoint AND user_id = private.current_user_id() RETURNING 1)
  SELECT jsonb_build_object('ok', true, 'removed', (SELECT count(*) FROM d))
$$;
REVOKE ALL ON FUNCTION public.push_subscribe(text, text, text, text), public.push_unsubscribe(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.push_subscribe(text, text, text, text), public.push_unsubscribe(text) TO authenticated;

-- The app reports addresses Apple/Google say are gone (phone reset, app removed); they're deleted. Needs the shared secret.
CREATE OR REPLACE FUNCTION public.push_gone(p_secret text, p_endpoints text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE n integer;
BEGIN
  IF p_secret IS NULL OR p_secret IS DISTINCT FROM (SELECT value FROM private.app_settings WHERE key = 'push_secret') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'FORBIDDEN');
  END IF;
  DELETE FROM public.push_subscriptions WHERE endpoint = ANY (p_endpoints);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'removed', n);
END $$;
REVOKE ALL ON FUNCTION public.push_gone(text, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.push_gone(text, text[]) TO anon, authenticated;

-- Where there is no pg_net (the test database), pushes are recorded here instead (who and the title only).
CREATE TABLE IF NOT EXISTS private.push_outbox (id bigserial PRIMARY KEY, users uuid[] NOT NULL, title text, url text, created_at timestamptz NOT NULL DEFAULT now());
REVOKE ALL ON private.push_outbox FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.push_to(p_users uuid[], p_title text, p_body text, p_url text, p_tag text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_subs jsonb; v_secret text; v_url text;
BEGIN
  SELECT coalesce(jsonb_agg(jsonb_build_object('endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth)), '[]'::jsonb) INTO v_subs
  FROM public.push_subscriptions s WHERE s.user_id = ANY (p_users);
  IF jsonb_array_length(v_subs) = 0 THEN RETURN; END IF;
  IF to_regnamespace('net') IS NULL THEN
    INSERT INTO private.push_outbox (users, title, url) VALUES (p_users, p_title, p_url);
    RETURN;
  END IF;
  SELECT value INTO v_secret FROM private.app_settings WHERE key = 'push_secret';
  SELECT value INTO v_url FROM private.app_settings WHERE key = 'push_url';
  EXECUTE 'SELECT net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := 8000)'
  USING v_url,
    jsonb_build_object('subs', v_subs, 'title', left(coalesce(p_title, 'Hermosapp'), 120), 'body', left(coalesce(p_body, ''), 240),
                       'url', coalesce(p_url, '/me'), 'tag', p_tag),
    jsonb_build_object('Content-Type', 'application/json', 'X-Push-Secret', v_secret);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'push skipped: %', SQLERRM;  -- a push problem never blocks the notice or message itself
END $$;
REVOKE ALL ON FUNCTION private.push_to(uuid[], text, text, text, text) FROM PUBLIC, anon, authenticated;

-- New notice -> push (chat tag notices are covered by the chat push below).
CREATE OR REPLACE FUNCTION private.push_notification() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.kind NOT LIKE 'CHAT%' THEN
    PERFORM private.push_to(ARRAY[NEW.user_id], NEW.title, NEW.body, coalesce(NEW.link, '/me'), NEW.kind);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS notifications_push ON public.notifications;
CREATE TRIGGER notifications_push AFTER INSERT ON public.notifications FOR EACH ROW EXECUTE FUNCTION private.push_notification();

-- New chat message -> push to the other members of that chat only.
CREATE OR REPLACE FUNCTION private.push_chat_message() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r public.chat_rooms%ROWTYPE; v_sender text; v_users uuid[];
BEGIN
  SELECT * INTO r FROM public.chat_rooms WHERE id = NEW.room_id;
  SELECT coalesce(nullif(btrim(e.nickname), ''), u.display_name) INTO v_sender
  FROM public.app_users u LEFT JOIN public.employees e ON e.app_user_id = u.id AND e.active WHERE u.id = NEW.sender_id LIMIT 1;
  SELECT array_agg(m.user_id) INTO v_users FROM public.chat_members m WHERE m.room_id = NEW.room_id AND m.user_id <> NEW.sender_id;
  IF v_users IS NULL THEN RETURN NEW; END IF;
  PERFORM private.push_to(v_users,
    CASE WHEN r.kind = 'GROUP' THEN coalesce(v_sender, 'Someone') || ' · ' || coalesce(r.name, 'Group') ELSE coalesce(v_sender, 'New message') END,
    CASE WHEN NEW.body IS NOT NULL THEN left(NEW.body, 200) WHEN NEW.photo_path IS NOT NULL THEN 'Sent a photo' WHEN NEW.gif_url IS NOT NULL THEN 'Sent a GIF' ELSE 'New message' END,
    '/chat/' || NEW.room_id::text, 'chat-' || NEW.room_id::text);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS chat_messages_push ON public.chat_messages;
CREATE TRIGGER chat_messages_push AFTER INSERT ON public.chat_messages FOR EACH ROW EXECUTE FUNCTION private.push_chat_message();
