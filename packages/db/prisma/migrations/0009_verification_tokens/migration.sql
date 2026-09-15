-- Auth.js verification tokens move out of a file in the web container and into the database (D-56).
--
-- The table is platform-level: a magic-link token is minted from an email address alone, before
-- anyone knows which tenant it belongs to, so there is no companyId to filter on. It is therefore
-- deliberately absent from the row-level-security loop in 0008 and from SCOPED_MODELS. Nothing
-- tenant-owned is reachable from it: the row holds an address, a digest and an expiry, and only
-- the API's `/internal/auth/verification-tokens` routes touch it.

-- CreateTable
CREATE TABLE "VerificationToken" (
    "identifier" TEXT NOT NULL,
    -- Already a hash: Auth.js hashes the token with AUTH_SECRET before the adapter sees it.
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_identifier_token_key" ON "VerificationToken"("identifier", "token");

-- CreateIndex: the prune sweeps by expiry.
CREATE INDEX "VerificationToken_expires_idx" ON "VerificationToken"("expires");

-- The runtime role needs to read, write and delete here. Migration 0008 set default privileges in
-- this schema, which already cover a table the same owner creates; this grant is stated explicitly
-- anyway, because those defaults are attached to the role that ran 0008 and a deployment whose
-- migrations later run as a different owner would silently leave the API unable to sign anyone in.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_api') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "VerificationToken" TO app_api;
  END IF;
END $$;
