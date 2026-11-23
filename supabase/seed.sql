-- Reference data only: the organization and its branches. No financial, patient or staff data.
INSERT INTO public.organizations (id, name) VALUES
  ('00000000-0000-4000-8000-000000000001', 'Hermosa Aesthetics')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.branches (organization_id, code, name, kind) VALUES
  ('00000000-0000-4000-8000-000000000001', 'QC_MAIN',   'Quezon City Main (Sikatuna)', 'CLINIC'),
  ('00000000-0000-4000-8000-000000000001', 'FAIRVIEW',  'Fairview',                    'CLINIC'),
  ('00000000-0000-4000-8000-000000000001', 'MARIKINA',  'Marikina',                    'CLINIC'),
  ('00000000-0000-4000-8000-000000000001', 'STA_MARIA', 'Sta. Maria Bulacan',          'CLINIC'),
  ('00000000-0000-4000-8000-000000000001', 'HQ',        'Head Office',                 'HQ')
ON CONFLICT (organization_id, code) DO NOTHING;
