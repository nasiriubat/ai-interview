-- Background documents of a campaign (D-491).
--
-- Additive only (docs/MIGRATIONS.md): one table. The organisation's own material for a campaign
-- (an org chart, process descriptions, the tools already in use), read like an attachment and used
-- by the interviewer as background and by the analysis as context, never as evidence. Deleted with
-- its campaign or tenant. Standard tenant policy.

CREATE TABLE "CampaignDocument" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "storageKey" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "summary" TEXT,
    "extractedText" TEXT,
    "uploadedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ingestedAt" TIMESTAMP(3),

    CONSTRAINT "CampaignDocument_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CampaignDocument_kind_check" CHECK ("kind" IN ('document', 'image')),
    CONSTRAINT "CampaignDocument_status_check" CHECK ("status" IN ('pending', 'ready', 'failed'))
);

CREATE INDEX "CampaignDocument_companyId_campaignId_idx" ON "CampaignDocument"("companyId", "campaignId");

ALTER TABLE "CampaignDocument" ADD CONSTRAINT "CampaignDocument_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CampaignDocument" ADD CONSTRAINT "CampaignDocument_campaignId_fkey"
  FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CampaignDocument" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "CampaignDocument";
CREATE POLICY tenant_isolation ON "CampaignDocument" TO app_api
  USING ("companyId" = current_setting('app.company_id', true)
         OR current_setting('app.company_id', true) = 'system')
  WITH CHECK ("companyId" = current_setting('app.company_id', true)
              OR current_setting('app.company_id', true) = 'system');
GRANT SELECT, INSERT, UPDATE, DELETE ON "CampaignDocument" TO app_api;
