-- HERMOSA OS 0004: the Supabase project is created with "Grant API access to new tables
-- automatically" OFF. Make the schema-level grants explicit so nothing depends on that default.
GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT USAGE ON SCHEMA private TO authenticated;
