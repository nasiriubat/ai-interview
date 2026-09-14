-- Row-level security, actually engaged (FR-01, NFR-03).
--
-- Migration 0002 wrote the policies, but the application kept connecting as the table owner,
-- which bypasses them, so the second fence never held. Two things change here.
--
-- 1. Every policy gains a system escape. Some work legitimately spans tenants or runs before a
--    tenant is known: resolving a bearer token to its principal, a platform operator acting
--    across companies, first-run bootstrap. Those set app.company_id to the literal 'system'.
--    It is a deliberate, greppable hole rather than an implicit one.
-- 2. SpecVersion joins the same loop, so one statement defines every policy instead of 0007's
--    separate copy drifting from the rest.
--
-- The policies apply to role app_api, which owns nothing and has no BYPASSRLS. Deployments point
-- the API and worker at that role; migrations and seeds keep using the owner.

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
  FOREACH t IN ARRAY ARRAY['User','Participant','InterviewTemplate','Campaign','Session','Attachment','Fact','Provider','Route','Budget','LlmCall','AuditLog','SpecVersion']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    -- Read: this tenant's rows, plus platform rows (companyId NULL), plus everything under 'system'.
    -- Write: only into this tenant, unless 'system', which may also write platform rows.
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I TO app_api'
      ' USING ("companyId" IS NULL'
      '        OR "companyId" = current_setting(''app.company_id'', true)'
      '        OR current_setting(''app.company_id'', true) = ''system'')'
      ' WITH CHECK ("companyId" = current_setting(''app.company_id'', true)'
      '             OR current_setting(''app.company_id'', true) = ''system'')',
      t);
  END LOOP;
END $$;

-- Rows a tenant may read but never reach through a companyId of their own: the job queue and the
-- settings catalog are shared infrastructure, so they stay outside the policy set deliberately.

-- pg-boss keeps its queue in its own schema and the runtime role has to work there too. The owner
-- creates the schema so the grants exist before the first boot; pg-boss installs its own tables,
-- which it may do as either role.
CREATE SCHEMA IF NOT EXISTS pgboss;
GRANT USAGE, CREATE ON SCHEMA pgboss TO app_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO app_api;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO app_api;
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_api;
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT USAGE, SELECT ON SEQUENCES TO app_api;
