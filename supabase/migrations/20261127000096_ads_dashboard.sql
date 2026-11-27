-- Hermosa OS update-0096: Business › Ads (Meta ads dashboard) and where each sale came from. Safe to run again.
-- SQL Editor: https://supabase.com/dashboard/project/bnopatuopnenbdhrecdt/sql/new
-- update-0096 (CHRIS Nov 27): "Make a neat intuitive and engaging dashboard for this in business called ads. Incorporate all
-- current findings. But be adjustable so when I upload actual sales log photos to identify actual sales sources".
--   1. ad_spend_monthly: Meta ad spend (pre-VAT) and new messages per month, per branch (by the Facebook page each ad ran
--      on) and per service (Hiko, Gluta, other). Filled with Jan 2025 – Nov 27 2026; owners and the GM add later months
--      from the Ads page.
--   2. service_log_sources: where a sale's client came from (Ad, Page/organic, Walk-in, Referral, Returning, Other),
--      set by owners and the GM from the Ads page (one by one, or a pasted list of SL numbers read off sales-log photos).
--      The Ads page turns it into ROAS from ad-sourced sales instead of total sales.
-- CHECK FIRST (changes nothing):
-- select case when exists (select 1 from pg_proc where proname = 'set_sales_sources') then 'ALREADY RUN: tick the box on your To-Do' else 'NOT RUN YET: run the rest of this file' end as result;

-- 1. Ad spend per month, branch and service. spend_cents is BEFORE VAT (the page adds 12% and marks it *).
CREATE TABLE IF NOT EXISTS public.ad_spend_monthly (
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  month date NOT NULL CHECK (extract(day FROM month) = 1),
  branch_id uuid NOT NULL REFERENCES public.branches(id),
  service text NOT NULL CHECK (service IN ('HIKO','GLUTA','OTHER')),
  spend_cents bigint NOT NULL CHECK (spend_cents BETWEEN 0 AND 100000000000),
  messages integer NOT NULL DEFAULT 0 CHECK (messages BETWEEN 0 AND 10000000),
  through date,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, month, branch_id, service)
);
ALTER TABLE public.ad_spend_monthly ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ad_spend_monthly_read ON public.ad_spend_monthly;
CREATE POLICY ad_spend_monthly_read ON public.ad_spend_monthly FOR SELECT TO authenticated
  USING (organization_id = private.current_org_id()
         AND (private.is_management(private.current_user_id()) OR private.has_role(ARRAY['FINANCE','AUDITOR'], NULL)));
REVOKE INSERT, UPDATE, DELETE ON public.ad_spend_monthly FROM anon, authenticated;
GRANT SELECT ON public.ad_spend_monthly TO authenticated;

-- 2. Where a sale came from. One row per Service log entry; no row = not known yet.
CREATE TABLE IF NOT EXISTS public.service_log_sources (
  service_log_id uuid PRIMARY KEY REFERENCES public.service_logs(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  source text NOT NULL CHECK (source IN ('AD','PAGE','WALK_IN','REFERRAL','RETURNING','OTHER')),
  set_by uuid REFERENCES public.app_users(id),
  set_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.service_log_sources ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_log_sources_read ON public.service_log_sources;
CREATE POLICY service_log_sources_read ON public.service_log_sources FOR SELECT TO authenticated
  USING (organization_id = private.current_org_id()
         AND (private.is_management(private.current_user_id()) OR private.has_role(ARRAY['FINANCE','AUDITOR'], NULL)));
REVOKE INSERT, UPDATE, DELETE ON public.service_log_sources FROM anon, authenticated;
GRANT SELECT ON public.service_log_sources TO authenticated;

-- Owners and the GM add or correct monthly ad spend.
-- p_rows: [{"month":"2026-12-01","branch":"QC_MAIN","service":"HIKO","spend_cents":123400,"messages":321,"through":"2026-12-15"}]
CREATE OR REPLACE FUNCTION public.save_ad_spend(p_rows jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id(); v_org uuid := private.current_org_id(); r jsonb; v_branch uuid; v_month date; n integer := 0;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT (private.has_role(ARRAY['OWNER'], NULL) OR private.is_gm()) THEN RETURN private.deny(NULL, 'ad_spend'); END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 OR jsonb_array_length(p_rows) > 2000 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
  END IF;
  -- Check every row before saving any.
  FOR r IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    IF coalesce(r ->> 'service', '') NOT IN ('HIKO','GLUTA','OTHER')
       OR coalesce(r ->> 'month', '') !~ '^\d{4}-\d{2}-01$'
       OR coalesce(r ->> 'spend_cents', '') !~ '^\d{1,11}$'
       OR coalesce(r ->> 'messages', '0') !~ '^\d{1,7}$'
       OR (r ->> 'through' IS NOT NULL AND (r ->> 'through') !~ '^\d{4}-\d{2}-\d{2}$')
       OR NOT EXISTS (SELECT 1 FROM public.branches b WHERE b.organization_id = v_org AND b.code = r ->> 'branch' AND b.kind = 'CLINIC') THEN
      RETURN jsonb_build_object('ok', false, 'error', 'BAD_ROW', 'row', r);
    END IF;
  END LOOP;
  FOR r IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    SELECT b.id INTO v_branch FROM public.branches b WHERE b.organization_id = v_org AND b.code = r ->> 'branch';
    v_month := (r ->> 'month')::date;
    INSERT INTO public.ad_spend_monthly AS a (organization_id, month, branch_id, service, spend_cents, messages, through, updated_at)
    VALUES (v_org, v_month, v_branch, r ->> 'service', (r ->> 'spend_cents')::bigint, coalesce((r ->> 'messages')::integer, 0), (r ->> 'through')::date, now())
    ON CONFLICT (organization_id, month, branch_id, service) DO UPDATE
      SET spend_cents = excluded.spend_cents, messages = excluded.messages, through = excluded.through, updated_at = now();
    n := n + 1;
  END LOOP;
  PERFORM private.audit(NULL, 'AD_SPEND_SAVED', 'ad_spend', NULL, NULL, jsonb_build_object('rows', n));
  RETURN jsonb_build_object('ok', true, 'saved', n);
END $$;
REVOKE ALL ON FUNCTION public.save_ad_spend(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_ad_spend(jsonb) TO authenticated;

-- Owners and the GM set where sales came from, by entry id or SL number. A null source clears it.
-- p_rows: [{"log":"<uuid>","source":"AD"}, {"log_no":"SL-2611-0012","source":"WALK_IN"}, {"log_no":"SL-2611-0013","source":null}]
-- Returns the SL numbers it couldn't find, so the page can show them.
CREATE OR REPLACE FUNCTION public.set_sales_sources(p_rows jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user uuid := private.current_user_id(); v_org uuid := private.current_org_id(); r jsonb; v_log uuid; v_src text;
  n integer := 0; v_missing jsonb := '[]'::jsonb;
BEGIN
  IF v_user IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'NOT_AUTHENTICATED'); END IF;
  IF NOT (private.has_role(ARRAY['OWNER'], NULL) OR private.is_gm()) THEN RETURN private.deny(NULL, 'sales_source'); END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 OR jsonb_array_length(p_rows) > 2000 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
  END IF;
  -- Check every source before saving any.
  FOR r IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    IF jsonb_typeof(r) <> 'object' OR (r ->> 'source' IS NOT NULL AND (r ->> 'source') NOT IN ('AD','PAGE','WALK_IN','REFERRAL','RETURNING','OTHER')) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'BAD_SOURCE', 'row', r);
    END IF;
  END LOOP;
  FOR r IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    v_src := r ->> 'source';
    v_log := NULL;
    IF coalesce(r ->> 'log', '') ~ '^[0-9a-fA-F-]{36}$' THEN
      SELECT l.id INTO v_log FROM public.service_logs l WHERE l.id = (r ->> 'log')::uuid AND l.organization_id = v_org;
    ELSIF r ->> 'log_no' IS NOT NULL THEN
      SELECT l.id INTO v_log FROM public.service_logs l WHERE l.organization_id = v_org AND upper(l.log_no) = upper(btrim(r ->> 'log_no'));
    END IF;
    IF v_log IS NULL THEN
      v_missing := v_missing || to_jsonb(coalesce(r ->> 'log_no', r ->> 'log', '?'));
      CONTINUE;
    END IF;
    IF v_src IS NULL THEN
      DELETE FROM public.service_log_sources WHERE service_log_id = v_log;
    ELSE
      INSERT INTO public.service_log_sources AS s (service_log_id, organization_id, source, set_by, set_at)
      VALUES (v_log, v_org, v_src, v_user, now())
      ON CONFLICT (service_log_id) DO UPDATE SET source = excluded.source, set_by = excluded.set_by, set_at = now();
    END IF;
    n := n + 1;
  END LOOP;
  IF n > 0 THEN PERFORM private.audit(NULL, 'SALES_SOURCES_SET', 'service_log', NULL, NULL, jsonb_build_object('rows', n)); END IF;
  RETURN jsonb_build_object('ok', true, 'saved', n, 'missing', v_missing);
END $$;
REVOKE ALL ON FUNCTION public.set_sales_sources(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_sales_sources(jsonb) TO authenticated;

-- Meta ads history, Jan 2025 – Nov 27 2026 (Windsor, all Hermosa ad accounts; branch = the Facebook page each ad ran on;
-- Hiko/Gluta by campaign name, drip = Gluta; hiring ads left out). Pre-VAT centavos. Re-running keeps later edits.
INSERT INTO public.ad_spend_monthly (organization_id, month, branch_id, service, spend_cents, messages, through)
SELECT b.organization_id, v.m::date, b.id, v.s, v.c, v.n, CASE WHEN v.m = '2026-11-01' THEN DATE '2026-11-27' END
FROM (VALUES
('2025-01-01','FAIRVIEW','GLUTA',1548730,859),
('2025-01-01','FAIRVIEW','HIKO',4627635,1048),
('2025-01-01','FAIRVIEW','OTHER',3448902,746),
('2025-01-01','MARIKINA','GLUTA',1552267,994),
('2025-01-01','MARIKINA','HIKO',3809875,1128),
('2025-01-01','MARIKINA','OTHER',1878291,426),
('2025-01-01','QC_MAIN','GLUTA',3168740,1603),
('2025-01-01','QC_MAIN','HIKO',11074284,3527),
('2025-01-01','QC_MAIN','OTHER',5381126,1127),
('2025-01-01','STA_MARIA','GLUTA',1547763,733),
('2025-01-01','STA_MARIA','HIKO',3847550,1138),
('2025-01-01','STA_MARIA','OTHER',1942184,373),
('2025-02-01','FAIRVIEW','GLUTA',1539230,554),
('2025-02-01','FAIRVIEW','HIKO',4385168,704),
('2025-02-01','FAIRVIEW','OTHER',1643559,271),
('2025-02-01','MARIKINA','GLUTA',1389089,563),
('2025-02-01','MARIKINA','HIKO',4136444,714),
('2025-02-01','MARIKINA','OTHER',1860041,312),
('2025-02-01','QC_MAIN','GLUTA',2795107,936),
('2025-02-01','QC_MAIN','HIKO',10704127,2226),
('2025-02-01','QC_MAIN','OTHER',3266601,537),
('2025-02-01','STA_MARIA','GLUTA',1398282,455),
('2025-02-01','STA_MARIA','HIKO',3869264,820),
('2025-02-01','STA_MARIA','OTHER',1948920,303),
('2025-03-01','FAIRVIEW','GLUTA',1544758,422),
('2025-03-01','FAIRVIEW','HIKO',6316298,866),
('2025-03-01','FAIRVIEW','OTHER',1338943,280),
('2025-03-01','MARIKINA','GLUTA',1555310,526),
('2025-03-01','MARIKINA','HIKO',6322310,1023),
('2025-03-01','MARIKINA','OTHER',1202404,263),
('2025-03-01','QC_MAIN','GLUTA',3014503,897),
('2025-03-01','QC_MAIN','HIKO',13967676,2371),
('2025-03-01','QC_MAIN','OTHER',1582835,228),
('2025-03-01','STA_MARIA','GLUTA',1729608,475),
('2025-03-01','STA_MARIA','HIKO',4872353,895),
('2025-03-01','STA_MARIA','OTHER',1807819,343),
('2025-04-01','FAIRVIEW','GLUTA',1509041,441),
('2025-04-01','FAIRVIEW','HIKO',6316978,1193),
('2025-04-01','FAIRVIEW','OTHER',947732,227),
('2025-04-01','MARIKINA','GLUTA',1504787,543),
('2025-04-01','MARIKINA','HIKO',6682805,1173),
('2025-04-01','MARIKINA','OTHER',861180,188),
('2025-04-01','QC_MAIN','GLUTA',3903827,1033),
('2025-04-01','QC_MAIN','HIKO',14467765,2669),
('2025-04-01','QC_MAIN','OTHER',957254,144),
('2025-04-01','STA_MARIA','GLUTA',1507358,455),
('2025-04-01','STA_MARIA','HIKO',4900127,1096),
('2025-04-01','STA_MARIA','OTHER',1220618,250),
('2025-05-01','FAIRVIEW','GLUTA',1789367,504),
('2025-05-01','FAIRVIEW','HIKO',6229080,1681),
('2025-05-01','FAIRVIEW','OTHER',724931,207),
('2025-05-01','MARIKINA','GLUTA',1534099,443),
('2025-05-01','MARIKINA','HIKO',6614960,1140),
('2025-05-01','MARIKINA','OTHER',770231,178),
('2025-05-01','QC_MAIN','GLUTA',3798159,836),
('2025-05-01','QC_MAIN','HIKO',16406339,4731),
('2025-05-01','QC_MAIN','OTHER',439687,113),
('2025-05-01','STA_MARIA','GLUTA',1540539,469),
('2025-05-01','STA_MARIA','HIKO',4619780,1056),
('2025-05-01','STA_MARIA','OTHER',922605,195),
('2025-06-01','FAIRVIEW','GLUTA',2110003,525),
('2025-06-01','FAIRVIEW','HIKO',7545720,2102),
('2025-06-01','MARIKINA','GLUTA',1169728,293),
('2025-06-01','MARIKINA','HIKO',5982347,956),
('2025-06-01','MARIKINA','OTHER',324339,71),
('2025-06-01','QC_MAIN','GLUTA',2876067,679),
('2025-06-01','QC_MAIN','HIKO',16944474,4413),
('2025-06-01','STA_MARIA','GLUTA',1504582,416),
('2025-06-01','STA_MARIA','HIKO',4177657,907),
('2025-06-01','STA_MARIA','OTHER',904156,203),
('2025-07-01','FAIRVIEW','GLUTA',2165171,492),
('2025-07-01','FAIRVIEW','HIKO',8043253,2296),
('2025-07-01','MARIKINA','GLUTA',926555,263),
('2025-07-01','MARIKINA','HIKO',5708339,1097),
('2025-07-01','QC_MAIN','GLUTA',2799710,620),
('2025-07-01','QC_MAIN','HIKO',13969397,3040),
('2025-07-01','STA_MARIA','GLUTA',1544326,407),
('2025-07-01','STA_MARIA','HIKO',4007234,1016),
('2025-07-01','STA_MARIA','OTHER',925122,201),
('2025-08-01','FAIRVIEW','GLUTA',2174996,487),
('2025-08-01','FAIRVIEW','HIKO',7738600,2251),
('2025-08-01','MARIKINA','GLUTA',928282,292),
('2025-08-01','MARIKINA','HIKO',5668497,1100),
('2025-08-01','QC_MAIN','GLUTA',3276037,841),
('2025-08-01','QC_MAIN','HIKO',16438074,3765),
('2025-08-01','STA_MARIA','GLUTA',1548004,447),
('2025-08-01','STA_MARIA','HIKO',3835213,961),
('2025-08-01','STA_MARIA','OTHER',928828,213),
('2025-09-01','FAIRVIEW','GLUTA',2097385,440),
('2025-09-01','FAIRVIEW','HIKO',7492445,2170),
('2025-09-01','MARIKINA','GLUTA',899166,260),
('2025-09-01','MARIKINA','HIKO',5537060,1155),
('2025-09-01','QC_MAIN','GLUTA',2957189,561),
('2025-09-01','QC_MAIN','HIKO',14803618,3369),
('2025-09-01','STA_MARIA','GLUTA',1497526,410),
('2025-09-01','STA_MARIA','HIKO',3594253,916),
('2025-09-01','STA_MARIA','OTHER',898762,166),
('2025-10-01','FAIRVIEW','GLUTA',2147979,459),
('2025-10-01','FAIRVIEW','HIKO',7699957,2362),
('2025-10-01','FAIRVIEW','OTHER',38305,26),
('2025-10-01','MARIKINA','GLUTA',902343,265),
('2025-10-01','MARIKINA','HIKO',5043778,1048),
('2025-10-01','MARIKINA','OTHER',227240,96),
('2025-10-01','QC_MAIN','GLUTA',3094906,572),
('2025-10-01','QC_MAIN','HIKO',15074201,3175),
('2025-10-01','QC_MAIN','OTHER',134032,34),
('2025-10-01','STA_MARIA','GLUTA',1449869,430),
('2025-10-01','STA_MARIA','HIKO',3227227,863),
('2025-10-01','STA_MARIA','OTHER',829099,223),
('2025-11-01','FAIRVIEW','GLUTA',3541425,732),
('2025-11-01','FAIRVIEW','HIKO',7281315,1690),
('2025-11-01','MARIKINA','GLUTA',1052908,245),
('2025-11-01','MARIKINA','HIKO',4294659,839),
('2025-11-01','QC_MAIN','GLUTA',2924529,479),
('2025-11-01','QC_MAIN','HIKO',13210445,3037),
('2025-11-01','STA_MARIA','GLUTA',1503527,459),
('2025-11-01','STA_MARIA','HIKO',2705276,768),
('2025-12-01','FAIRVIEW','GLUTA',4296710,679),
('2025-12-01','FAIRVIEW','HIKO',7654036,1775),
('2025-12-01','MARIKINA','GLUTA',979316,234),
('2025-12-01','MARIKINA','HIKO',3652088,627),
('2025-12-01','QC_MAIN','GLUTA',3047736,463),
('2025-12-01','QC_MAIN','HIKO',13652033,3146),
('2025-12-01','STA_MARIA','GLUTA',1541929,370),
('2025-12-01','STA_MARIA','HIKO',2790115,707),
('2026-01-01','FAIRVIEW','GLUTA',4331945,935),
('2026-01-01','FAIRVIEW','HIKO',7454602,2202),
('2026-01-01','MARIKINA','GLUTA',1118994,337),
('2026-01-01','MARIKINA','HIKO',4112043,837),
('2026-01-01','QC_MAIN','GLUTA',3038030,567),
('2026-01-01','QC_MAIN','HIKO',13658224,4343),
('2026-01-01','QC_MAIN','OTHER',15,0),
('2026-01-01','STA_MARIA','GLUTA',1517988,493),
('2026-01-01','STA_MARIA','HIKO',2744181,990),
('2026-02-01','FAIRVIEW','GLUTA',3911110,804),
('2026-02-01','FAIRVIEW','HIKO',5021172,1317),
('2026-02-01','MARIKINA','GLUTA',977949,297),
('2026-02-01','MARIKINA','HIKO',3242802,904),
('2026-02-01','QC_MAIN','GLUTA',1955755,375),
('2026-02-01','QC_MAIN','HIKO',9497621,2610),
('2026-02-01','QC_MAIN','OTHER',127048,15),
('2026-02-01','STA_MARIA','GLUTA',979311,310),
('2026-02-01','STA_MARIA','HIKO',2720287,912),
('2026-03-01','FAIRVIEW','GLUTA',1803356,481),
('2026-03-01','FAIRVIEW','HIKO',5873191,1101),
('2026-03-01','FAIRVIEW','OTHER',805672,158),
('2026-03-01','MARIKINA','GLUTA',1086517,266),
('2026-03-01','MARIKINA','HIKO',3801500,860),
('2026-03-01','MARIKINA','OTHER',679446,142),
('2026-03-01','QC_MAIN','GLUTA',2273773,367),
('2026-03-01','QC_MAIN','HIKO',13732377,3744),
('2026-03-01','QC_MAIN','OTHER',905190,128),
('2026-03-01','STA_MARIA','GLUTA',925981,228),
('2026-03-01','STA_MARIA','HIKO',4669389,1537),
('2026-03-01','STA_MARIA','OTHER',628210,120),
('2026-04-01','FAIRVIEW','GLUTA',1253062,98),
('2026-04-01','FAIRVIEW','HIKO',5657215,1466),
('2026-04-01','MARIKINA','GLUTA',1052871,373),
('2026-04-01','MARIKINA','HIKO',3770388,687),
('2026-04-01','MARIKINA','OTHER',312713,45),
('2026-04-01','QC_MAIN','GLUTA',3042942,576),
('2026-04-01','QC_MAIN','HIKO',14723908,2399),
('2026-04-01','STA_MARIA','GLUTA',746480,284),
('2026-04-01','STA_MARIA','HIKO',4579086,1601),
('2026-04-01','STA_MARIA','OTHER',373595,61),
('2026-05-01','FAIRVIEW','GLUTA',1046580,162),
('2026-05-01','FAIRVIEW','HIKO',6325451,1575),
('2026-05-01','MARIKINA','GLUTA',1082527,380),
('2026-05-01','MARIKINA','HIKO',3980359,840),
('2026-05-01','MARIKINA','OTHER',577910,84),
('2026-05-01','QC_MAIN','GLUTA',3094682,613),
('2026-05-01','QC_MAIN','HIKO',16046157,3855),
('2026-05-01','STA_MARIA','GLUTA',775111,341),
('2026-05-01','STA_MARIA','HIKO',4731077,1789),
('2026-05-01','STA_MARIA','OTHER',699633,153),
('2026-06-01','FAIRVIEW','GLUTA',1858008,268),
('2026-06-01','FAIRVIEW','HIKO',5295231,1351),
('2026-06-01','MARIKINA','GLUTA',1055550,346),
('2026-06-01','MARIKINA','HIKO',3901673,1052),
('2026-06-01','MARIKINA','OTHER',113725,15),
('2026-06-01','QC_MAIN','GLUTA',2281688,427),
('2026-06-01','QC_MAIN','HIKO',15437468,3682),
('2026-06-01','STA_MARIA','GLUTA',755048,314),
('2026-06-01','STA_MARIA','HIKO',4712693,1603),
('2026-06-01','STA_MARIA','OTHER',671218,123),
('2026-07-01','FAIRVIEW','HIKO',7756240,1433),
('2026-07-01','MARIKINA','GLUTA',1074940,332),
('2026-07-01','MARIKINA','HIKO',3856544,1663),
('2026-07-01','QC_MAIN','HIKO',18549696,4899),
('2026-07-01','STA_MARIA','GLUTA',758603,296),
('2026-07-01','STA_MARIA','HIKO',6164137,1263),
('2026-08-01','FAIRVIEW','HIKO',7703516,2729),
('2026-08-01','MARIKINA','GLUTA',1081644,355),
('2026-08-01','MARIKINA','HIKO',3871075,1612),
('2026-08-01','QC_MAIN','HIKO',18754500,5604),
('2026-08-01','STA_MARIA','GLUTA',780880,325),
('2026-08-01','STA_MARIA','HIKO',6248201,1389),
('2026-09-01','FAIRVIEW','HIKO',9062442,2957),
('2026-09-01','MARIKINA','GLUTA',849326,256),
('2026-09-01','MARIKINA','HIKO',3789740,1170),
('2026-09-01','QC_MAIN','HIKO',17940315,4688),
('2026-09-01','STA_MARIA','GLUTA',748376,267),
('2026-09-01','STA_MARIA','HIKO',6074625,1189),
('2026-10-01','FAIRVIEW','GLUTA',367506,105),
('2026-10-01','FAIRVIEW','HIKO',8047883,1581),
('2026-10-01','MARIKINA','HIKO',5248189,1605),
('2026-10-01','QC_MAIN','GLUTA',220186,58),
('2026-10-01','QC_MAIN','HIKO',17837427,4463),
('2026-10-01','STA_MARIA','GLUTA',767361,266),
('2026-10-01','STA_MARIA','HIKO',6088376,1456),
('2026-11-01','FAIRVIEW','GLUTA',1332851,507),
('2026-11-01','FAIRVIEW','HIKO',4663194,1129),
('2026-11-01','MARIKINA','HIKO',4796169,1839),
('2026-11-01','QC_MAIN','HIKO',8396375,2748),
('2026-11-01','STA_MARIA','GLUTA',670283,284),
('2026-11-01','STA_MARIA','HIKO',5390679,1404)
) AS v(m, code, s, c, n)
JOIN public.branches b ON b.code = v.code AND b.kind = 'CLINIC'
ON CONFLICT (organization_id, month, branch_id, service) DO NOTHING;
