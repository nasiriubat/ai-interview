-- The built-in error log (D-477): what failed on the API, in the worker, on the web server and in
-- people's browsers, grouped by fingerprint so a recurring fault is one row whose count grows.
--
-- Additive only (docs/MIGRATIONS.md): two tables. Bounded by construction: the recorder keeps the
-- newest 20 occurrences of a group, and the daily `ops.error-log-sweep` job deletes what has not
-- been seen for `ops.errorLogRetentionDays` (7) and enforces a global ceiling on occurrences.
--
-- Row-level security (D-140, D-477). These rows are written from any tenant's request, but they
-- are not exempt: a group is keyed by fingerprint *and* tenant, so every row belongs to exactly one
-- tenant or, with companyId NULL, to the platform, and the table takes the nullable-companyId shape
-- OpsAlert uses. It is stricter than OpsAlert's in one respect: a tenant context does not see the
-- platform's rows either (no `"companyId" IS NULL` arm), because a platform error's message and
-- stack are nobody's business but the operator's. The recorders and the operator's routes run in
-- the 'system' context, which is the only one that reads or writes across tenants. Keeping the
-- fence means a tenant's offboarding removes its error rows with everything else it owns
-- (packages/core/src/tenancy/offboarding/tables.ts reads companyId columns from the catalogue).

CREATE TABLE "ErrorGroup" (
    "id" TEXT NOT NULL,
    "groupKey" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "companyId" TEXT,
    "source" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "route" TEXT,
    "jobName" TEXT,
    "count" INTEGER NOT NULL DEFAULT 1,
    "hourly" JSONB NOT NULL DEFAULT '{}',
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,

    CONSTRAINT "ErrorGroup_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ErrorOccurrence" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "companyId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "stack" TEXT,
    "route" TEXT,
    "path" TEXT,
    "method" TEXT,
    "status" INTEGER,
    "requestId" TEXT,
    "userId" TEXT,
    "sessionId" TEXT,
    "release" TEXT,
    "userAgent" TEXT,
    "jobName" TEXT,
    "jobAttempt" INTEGER,
    "jobFinal" BOOLEAN,

    CONSTRAINT "ErrorOccurrence_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ErrorGroup_groupKey_key" ON "ErrorGroup"("groupKey");
CREATE INDEX "ErrorGroup_lastSeenAt_idx" ON "ErrorGroup"("lastSeenAt");
CREATE INDEX "ErrorGroup_companyId_lastSeenAt_idx" ON "ErrorGroup"("companyId", "lastSeenAt");
CREATE INDEX "ErrorGroup_fingerprint_idx" ON "ErrorGroup"("fingerprint");
CREATE INDEX "ErrorOccurrence_groupId_occurredAt_idx" ON "ErrorOccurrence"("groupId", "occurredAt");
CREATE INDEX "ErrorOccurrence_occurredAt_idx" ON "ErrorOccurrence"("occurredAt");
CREATE INDEX "ErrorOccurrence_companyId_idx" ON "ErrorOccurrence"("companyId");

ALTER TABLE "ErrorGroup" ADD CONSTRAINT "ErrorGroup_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ErrorOccurrence" ADD CONSTRAINT "ErrorOccurrence_groupId_fkey"
  FOREIGN KEY ("groupId") REFERENCES "ErrorGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ErrorOccurrence" ADD CONSTRAINT "ErrorOccurrence_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ErrorGroup" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ErrorGroup";
CREATE POLICY tenant_isolation ON "ErrorGroup" TO app_api
  USING ("companyId" = current_setting('app.company_id', true)
         OR current_setting('app.company_id', true) = 'system')
  WITH CHECK ("companyId" = current_setting('app.company_id', true)
              OR current_setting('app.company_id', true) = 'system');

ALTER TABLE "ErrorOccurrence" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "ErrorOccurrence";
CREATE POLICY tenant_isolation ON "ErrorOccurrence" TO app_api
  USING ("companyId" = current_setting('app.company_id', true)
         OR current_setting('app.company_id', true) = 'system')
  WITH CHECK ("companyId" = current_setting('app.company_id', true)
              OR current_setting('app.company_id', true) = 'system');

-- Stated explicitly for the same reason as in 0009: default privileges belong to whoever ran 0008.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_api') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "ErrorGroup" TO app_api;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "ErrorOccurrence" TO app_api;
  END IF;
END $$;
