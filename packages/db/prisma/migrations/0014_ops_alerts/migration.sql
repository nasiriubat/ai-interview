-- Operational alerts (D-90): the dedupe, rate-limit and history store behind AlertPort.
--
-- One row per alert key. `companyId` is nullable because most of what an operator is told about
-- is not a tenant's: a full disk, a missing backup, a dead-lettered job. It is set for a budget
-- notice, which is the one kind a tenant's admins are also sent.
--
-- Row-level security (D-67): the table carries a companyId, so it needs the same policy as its
-- siblings or deploy/preflight.sh refuses to start the stack, correctly. It is the nullable shape
-- Provider, Route and PromptVersion use: a tenant reads its own rows and the platform's, and may
-- write only its own. A platform row (companyId NULL) is therefore writable only under the
-- 'system' context, which is how the alert router runs.

-- CreateTable
CREATE TABLE "OpsAlert" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "companyId" TEXT,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL DEFAULT '',
    "count" INTEGER NOT NULL DEFAULT 1,
    "firstAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notifiedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "context" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "OpsAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OpsAlert_key_key" ON "OpsAlert"("key");

-- CreateIndex
CREATE INDEX "OpsAlert_kind_lastAt_idx" ON "OpsAlert"("kind", "lastAt");

-- CreateIndex
CREATE INDEX "OpsAlert_companyId_lastAt_idx" ON "OpsAlert"("companyId", "lastAt");

-- AddForeignKey
ALTER TABLE "OpsAlert" ADD CONSTRAINT "OpsAlert_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OpsAlert" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "OpsAlert";
CREATE POLICY tenant_isolation ON "OpsAlert" TO app_api
  USING ("companyId" IS NULL
         OR "companyId" = current_setting('app.company_id', true)
         OR current_setting('app.company_id', true) = 'system')
  WITH CHECK ("companyId" = current_setting('app.company_id', true)
              OR current_setting('app.company_id', true) = 'system');
GRANT SELECT, INSERT, UPDATE, DELETE ON "OpsAlert" TO app_api;

-- `cost.onBudgetExceeded` is removed from the settings catalog (D-91): "downgrade" was never read
-- by anything, so a stored value was a promise nobody kept. The service already ignores keys it
-- does not know; this removes the rows so the admin UI and exports stop carrying them.
DELETE FROM "Setting" WHERE "key" = 'cost.onBudgetExceeded';
