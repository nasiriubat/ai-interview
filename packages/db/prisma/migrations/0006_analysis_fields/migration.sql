-- AlterTable
ALTER TABLE "Analysis" ADD COLUMN     "preliminary" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Opportunity" ADD COLUMN     "dataNeeded" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "promotedSessionId" TEXT,
ADD COLUMN     "risks" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "stats" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "whyNotAi" TEXT;

-- AlterTable
ALTER TABLE "Report" ADD COLUMN     "sections" JSONB NOT NULL DEFAULT '[]';

