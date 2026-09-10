-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "allowedEmailDomains" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "verification" TEXT NOT NULL DEFAULT 'email_code';

-- AlterTable
ALTER TABLE "InterviewTemplate" ADD COLUMN     "closingQuestion" TEXT NOT NULL DEFAULT 'Is there anything important I did not ask about?',
ADD COLUMN     "contextBlock" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "endSummary" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "issueDetection" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "language" TEXT NOT NULL DEFAULT 'en',
ADD COLUMN     "maxAssistantChars" INTEGER NOT NULL DEFAULT 600,
ADD COLUMN     "maxTurns" INTEGER NOT NULL DEFAULT 60,
ADD COLUMN     "pathSelection" TEXT NOT NULL DEFAULT 'none',
ADD COLUMN     "widgetPolicy" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "areaKey" TEXT,
ADD COLUMN     "widget" JSONB,
ADD COLUMN     "widgetResponse" JSONB;

-- AlterTable
ALTER TABLE "Session" DROP COLUMN "technicalLevel",
ADD COLUMN     "modePreference" TEXT NOT NULL DEFAULT 'chat',
ADD COLUMN     "path" TEXT,
ADD COLUMN     "templateVersion" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "Invitation" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "emailHash" TEXT NOT NULL,
    "email" TEXT,
    "tokenHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "sessionId" TEXT,
    "sentAt" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignEmailHash" (
    "campaignId" TEXT NOT NULL,
    "emailHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignEmailHash_pkey" PRIMARY KEY ("campaignId","emailHash")
);

-- CreateTable
CREATE TABLE "EmailCode" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "emailHash" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL DEFAULT '',
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "changedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromptVersion" (
    "id" TEXT NOT NULL,
    "companyId" TEXT,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "canaryShare" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromptVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_tokenHash_key" ON "Invitation"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_sessionId_key" ON "Invitation"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_campaignId_emailHash_key" ON "Invitation"("campaignId", "emailHash");

-- CreateIndex
CREATE INDEX "EmailCode_campaignId_emailHash_idx" ON "EmailCode"("campaignId", "emailHash");

-- CreateIndex
CREATE UNIQUE INDEX "Setting_scope_scopeId_key_key" ON "Setting"("scope", "scopeId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "PromptVersion_companyId_key_version_key" ON "PromptVersion"("companyId", "key", "version");

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignEmailHash" ADD CONSTRAINT "CampaignEmailHash_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

