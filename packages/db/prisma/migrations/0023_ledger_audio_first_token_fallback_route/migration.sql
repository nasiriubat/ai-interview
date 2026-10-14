-- Ledger completeness, first-token latency and the fallback route (Operations M2, D-220 to D-222,
-- D-228).
--
-- Additive only: every column is nullable or carries a default, so the previous release's code
-- keeps working against this schema (docs/MIGRATIONS.md).
--
-- 1. LlmCall learns what it did not record: time to the first streamed token (the number NFR-01
--    puts a target on), audio seconds and TTS characters (the units speech is priced in), whether
--    the usage is our estimate rather than the provider's, and which route tier served the call.
-- 2. ModelPrice gets the two prices those units need: USD per minute of audio, USD per million
--    characters of speech.
-- 3. FallbackRoute: the route a purpose uses when its primary provider is down. A sibling table
--    rather than a tier column on Route, because every reader of Route assumes one row per
--    (company, purpose). Row-level security is the nullable-company shape Route uses.

ALTER TABLE "LlmCall"
  ADD COLUMN "firstTokenMs"  INTEGER,
  ADD COLUMN "audioSeconds"  DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "ttsCharacters" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "estimated"     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "routeTier"     TEXT NOT NULL DEFAULT 'primary';

-- The p95 read: first-token latencies of one tenant over a window, for the chatty purposes.
CREATE INDEX "LlmCall_companyId_purpose_createdAt_idx" ON "LlmCall"("companyId", "purpose", "createdAt");

ALTER TABLE "ModelPrice"
  ADD COLUMN "audioPerMinute" DOUBLE PRECISION,
  ADD COLUMN "ttsPerMChars"   DOUBLE PRECISION;

CREATE TABLE "FallbackRoute" (
    "id" TEXT NOT NULL,
    "companyId" TEXT,
    "purpose" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "effort" TEXT,
    "maxOutputTokens" INTEGER NOT NULL,

    CONSTRAINT "FallbackRoute_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FallbackRoute_companyId_purpose_key" ON "FallbackRoute"("companyId", "purpose");
-- A NULL company is distinct to a unique index, so the platform default needs its own.
CREATE UNIQUE INDEX "FallbackRoute_platform_purpose_key" ON "FallbackRoute"("purpose") WHERE "companyId" IS NULL;

ALTER TABLE "FallbackRoute" ADD CONSTRAINT "FallbackRoute_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FallbackRoute" ADD CONSTRAINT "FallbackRoute_providerId_fkey"
  FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FallbackRoute" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "FallbackRoute";
CREATE POLICY tenant_isolation ON "FallbackRoute" TO app_api
  USING ("companyId" IS NULL
         OR "companyId" = current_setting('app.company_id', true)
         OR current_setting('app.company_id', true) = 'system')
  WITH CHECK ("companyId" = current_setting('app.company_id', true)
              OR current_setting('app.company_id', true) = 'system');
GRANT SELECT, INSERT, UPDATE, DELETE ON "FallbackRoute" TO app_api;
