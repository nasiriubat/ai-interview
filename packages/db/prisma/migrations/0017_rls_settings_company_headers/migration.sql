-- Row-level security for Setting, ModelPrice and Company, and an encrypted home for provider
-- headers (FR-01, NFR-03, NFR-07, D-141, D-147). Companion to 0016.
--
-- 1. Setting and ModelPrice are shared tables: a row either belongs to one tenant or to the
--    platform. They get a nullable `companyId` (NULL means platform, readable by every tenant and
--    writable only by the system context), in exactly the shape Provider, Route and PromptVersion
--    already use, so the same policy applies.
--
--    Unlike the tables in 0016 these have no single parent to point a composite key at: a setting
--    names its owner through (scope, scopeId), which is polymorphic. So a BEFORE trigger derives
--    `companyId` from the row's own scope, and an unforgeable derivation is stronger than asking
--    every writer to remember it. A writer that names a tenant it cannot see is refused by the
--    policy, because the derived value is what the policy then checks.
--
-- 2. Company had no policy, so any tenant context could list every tenant. It gets `id = current`.
--
-- 3. Provider.headersEnc: custom headers are credentials (a gateway's `x-api-key`), and were stored
--    and returned in plaintext. The ciphertext column lands here; the application encrypts the
--    existing values at boot, because the key lives in the application and not in SQL (D-147).

-- ---------------------------------------------------------------------------------------------
-- Setting
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "Setting" ADD COLUMN "companyId" TEXT;

UPDATE "Setting" SET "companyId" = NULL WHERE scope = 'platform';
UPDATE "Setting" SET "companyId" = "scopeId" WHERE scope = 'tenant';

-- A campaign- or template-scoped setting whose campaign or template no longer exists is dead data
-- (nothing can read it), and leaving it NULL would make it look like a platform value. Remove it.
DELETE FROM "Setting" s
 WHERE s.scope = 'campaign'
   AND NOT EXISTS (SELECT 1 FROM "Campaign" c WHERE c.id = s."scopeId");
DELETE FROM "Setting" s
 WHERE s.scope = 'template'
   AND NOT EXISTS (SELECT 1 FROM "InterviewTemplate" t WHERE t.id = s."scopeId");

UPDATE "Setting" s SET "companyId" = c."companyId" FROM "Campaign" c
 WHERE s.scope = 'campaign' AND c.id = s."scopeId";
-- A platform template (companyId NULL) keeps NULL: its settings are platform-wide by definition.
UPDATE "Setting" s SET "companyId" = t."companyId" FROM "InterviewTemplate" t
 WHERE s.scope = 'template' AND t.id = s."scopeId";

CREATE OR REPLACE FUNCTION aidp_derive_setting_company() RETURNS trigger AS $$
DECLARE
  owner text;
BEGIN
  IF NEW.scope = 'platform' THEN
    NEW."companyId" := NULL;
  ELSIF NEW.scope = 'tenant' THEN
    NEW."companyId" := NEW."scopeId";
  ELSIF NEW.scope = 'campaign' THEN
    SELECT "companyId" INTO owner FROM "Campaign" WHERE id = NEW."scopeId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'setting_scope_not_found' USING ERRCODE = 'foreign_key_violation';
    END IF;
    NEW."companyId" := owner;
  ELSIF NEW.scope = 'template' THEN
    SELECT "companyId" INTO owner FROM "InterviewTemplate" WHERE id = NEW."scopeId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'setting_scope_not_found' USING ERRCODE = 'foreign_key_violation';
    END IF;
    NEW."companyId" := owner;
  ELSE
    RAISE EXCEPTION 'setting_scope_unknown' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS aidp_setting_company ON "Setting";
CREATE TRIGGER aidp_setting_company BEFORE INSERT OR UPDATE OF scope, "scopeId", "companyId" ON "Setting"
  FOR EACH ROW EXECUTE FUNCTION aidp_derive_setting_company();

ALTER TABLE "Setting" ADD CONSTRAINT "Setting_company_by_scope_check" CHECK (
  (scope = 'platform' AND "companyId" IS NULL)
  OR (scope IN ('tenant', 'campaign') AND "companyId" IS NOT NULL)
  OR scope = 'template'
);

CREATE INDEX "Setting_companyId_idx" ON "Setting"("companyId");

-- ---------------------------------------------------------------------------------------------
-- ModelPrice
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "ModelPrice" ADD COLUMN "companyId" TEXT;

UPDATE "ModelPrice" m SET "companyId" = p."companyId"
  FROM "Provider" p WHERE p.id = m."providerId";

CREATE OR REPLACE FUNCTION aidp_derive_model_price_company() RETURNS trigger AS $$
BEGIN
  SELECT "companyId" INTO NEW."companyId" FROM "Provider" WHERE id = NEW."providerId";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'model_price_provider_not_found' USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS aidp_model_price_company ON "ModelPrice";
CREATE TRIGGER aidp_model_price_company BEFORE INSERT OR UPDATE OF "providerId", "companyId" ON "ModelPrice"
  FOR EACH ROW EXECUTE FUNCTION aidp_derive_model_price_company();

CREATE INDEX "ModelPrice_companyId_idx" ON "ModelPrice"("companyId");

-- ---------------------------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['Setting', 'ModelPrice']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I TO app_api'
      ' USING ("companyId" IS NULL'
      '        OR "companyId" = current_setting(''app.company_id'', true)'
      '        OR current_setting(''app.company_id'', true) = ''system'')'
      ' WITH CHECK ("companyId" = current_setting(''app.company_id'', true)'
      '             OR current_setting(''app.company_id'', true) = ''system'')',
      t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_api', t);
  END LOOP;
END $$;

-- Company is the tenant itself, so its key is `id`, not `companyId`. A tenant reads and changes its
-- own row; creating a tenant and listing them all is the system context's (the platform operator).
ALTER TABLE "Company" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "Company";
CREATE POLICY tenant_isolation ON "Company" TO app_api
  USING ("id" = current_setting('app.company_id', true)
         OR current_setting('app.company_id', true) = 'system')
  WITH CHECK ("id" = current_setting('app.company_id', true)
              OR current_setting('app.company_id', true) = 'system');
GRANT SELECT, INSERT, UPDATE, DELETE ON "Company" TO app_api;

-- ---------------------------------------------------------------------------------------------
-- Provider headers
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "Provider" ADD COLUMN "headersEnc" TEXT NOT NULL DEFAULT '';
