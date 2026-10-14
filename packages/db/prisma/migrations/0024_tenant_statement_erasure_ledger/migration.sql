-- The monthly tenant statement, the erasure ledger and the tenant audit purge (Operations M2/M3,
-- D-224, D-226, D-227).
--
-- Additive only (docs/MIGRATIONS.md): three new tables and one function.
--
-- 1. TenantStatement: one frozen row per tenant and month, written by the `billing.statement` job.
--    It outlives the ledger rows it summarises, which retention may later purge. Standard
--    tenant policy.
-- 2. ErasureLedger: what was erased on purpose (tenant offboarding, a participant's session), ids
--    only, so a restore from an older backup can erase it again. The row outlives the tenant, so
--    it carries no foreign key (`companyId` is a plain column, so the row can name a tenant that is gone); a tenant sees only its own entries and the system context all of them. The job
--    also appends each entry to a file outside the database, because a restore replaces this table
--    with the backup's copy, which is exactly the copy that predates the erasure.
-- 3. audit_purge_tenant(): the one way an AuditLog row is ever deleted (migration 0019 reserved
--    the purge flag for the tenant-purge job). app_api has no DELETE on AuditLog, so the purge
--    cannot be a statement it runs; it is a SECURITY DEFINER function owned by the migration role
--    that sets the flag itself, and that refuses unless the tenant is already `offboarding`, so a
--    live tenant's audit trail cannot be removed through it.

CREATE TABLE "TenantStatement" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "lines" JSONB NOT NULL,
    "totals" JSONB NOT NULL,
    "counts" JSONB NOT NULL,

    CONSTRAINT "TenantStatement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TenantStatement_companyId_month_key" ON "TenantStatement"("companyId", "month");
ALTER TABLE "TenantStatement" ADD CONSTRAINT "TenantStatement_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TenantStatement" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "TenantStatement";
CREATE POLICY tenant_isolation ON "TenantStatement" TO app_api
  USING ("companyId" = current_setting('app.company_id', true)
         OR current_setting('app.company_id', true) = 'system')
  WITH CHECK ("companyId" = current_setting('app.company_id', true)
              OR current_setting('app.company_id', true) = 'system');
GRANT SELECT, INSERT, UPDATE, DELETE ON "TenantStatement" TO app_api;

CREATE TABLE "ErasureLedger" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "erasedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requestedBy" TEXT,

    CONSTRAINT "ErasureLedger_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ErasureLedger_kind_targetId_key" ON "ErasureLedger"("kind", "targetId");

ALTER TABLE "ErasureLedger" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ErasureLedger";
CREATE POLICY tenant_isolation ON "ErasureLedger" TO app_api
  USING ("companyId" = current_setting('app.company_id', true)
         OR current_setting('app.company_id', true) = 'system')
  WITH CHECK ("companyId" = current_setting('app.company_id', true)
              OR current_setting('app.company_id', true) = 'system');
GRANT SELECT, INSERT, UPDATE, DELETE ON "ErasureLedger" TO app_api;

CREATE OR REPLACE FUNCTION audit_purge_tenant(target TEXT) RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  state TEXT;
  removed INTEGER;
BEGIN
  SELECT c.status INTO state FROM "Company" c WHERE c.id = target;
  IF state IS DISTINCT FROM 'offboarding' THEN
    RAISE EXCEPTION 'audit_purge_tenant: tenant % is not offboarding', target
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Transaction-local, and switched off again before returning, so nothing the caller runs after
  -- this call in the same transaction inherits the flag.
  PERFORM set_config('app.audit_purge', 'on', true);
  DELETE FROM "AuditLog" WHERE "companyId" = target;
  GET DIAGNOSTICS removed = ROW_COUNT;
  PERFORM set_config('app.audit_purge', 'off', true);
  RETURN removed;
END $$;

REVOKE ALL ON FUNCTION audit_purge_tenant(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_purge_tenant(TEXT) TO app_api;
