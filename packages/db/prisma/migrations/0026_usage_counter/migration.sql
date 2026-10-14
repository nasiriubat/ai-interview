-- Abuse counters for open links and the email-code flow (Security M3, A1, D-261).
--
-- Additive only (docs/MIGRATIONS.md): one table. Fixed-window counters keyed by tenant, subject
-- (a campaign id, or a keyed hash of a client address) and window start, incremented with an
-- atomic upsert so the count is shared by every replica and survives a restart. The key carries
-- no address and no email. Standard tenant policy; the retention sweep deletes rows older than
-- two days.

CREATE TABLE "UsageCounter" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageCounter_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UsageCounter_companyId_key_windowStart_key" ON "UsageCounter"("companyId", "key", "windowStart");
CREATE INDEX "UsageCounter_windowStart_idx" ON "UsageCounter"("windowStart");

ALTER TABLE "UsageCounter" ADD CONSTRAINT "UsageCounter_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UsageCounter" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "UsageCounter";
CREATE POLICY tenant_isolation ON "UsageCounter" TO app_api
  USING ("companyId" = current_setting('app.company_id', true)
         OR current_setting('app.company_id', true) = 'system')
  WITH CHECK ("companyId" = current_setting('app.company_id', true)
              OR current_setting('app.company_id', true) = 'system');
GRANT SELECT, INSERT, UPDATE, DELETE ON "UsageCounter" TO app_api;
