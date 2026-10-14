-- Prompt administration (D-230): who wrote a tenant prompt version and when it was in force.
-- Additive only: nullable columns and an index.
ALTER TABLE "PromptVersion" ADD COLUMN "note" TEXT;
ALTER TABLE "PromptVersion" ADD COLUMN "activatedAt" TIMESTAMP(3);
ALTER TABLE "PromptVersion" ADD COLUMN "deactivatedAt" TIMESTAMP(3);
ALTER TABLE "PromptVersion" ADD COLUMN "parentVersion" INTEGER;
CREATE INDEX "PromptVersion_companyId_key_idx" ON "PromptVersion"("companyId", "key");
