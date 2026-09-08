-- Row-level security as the second tenancy fence (FR-01, NFR-03).
-- The application connects as role app_api (not the table owner) and runs
--   SET LOCAL app.company_id = '<companyId>'
-- at the start of every request transaction. The owner role (migrations, seeds,
-- platform-operator jobs) bypasses RLS.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_api') THEN
    CREATE ROLE app_api NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO app_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_api;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_api;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['User','Participant','InterviewTemplate','Campaign','Session','Attachment','Fact','Provider','Route','Budget','LlmCall','AuditLog']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    -- Platform-level rows (companyId NULL) are readable by every tenant; writes to them need the owner role.
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I TO app_api USING ("companyId" IS NULL OR "companyId" = current_setting(''app.company_id'', true)) WITH CHECK ("companyId" = current_setting(''app.company_id'', true))',
      t);
  END LOOP;
END $$;
