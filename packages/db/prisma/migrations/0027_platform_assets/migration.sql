-- The platform's own public branding files: the site logo (D-432).
--
-- Additive only (docs/MIGRATIONS.md): one table. Platform-level and outside row-level security,
-- like VerificationToken (deploy/rls-exempt.txt): it carries no companyId, it holds only what
-- `GET /public/branding/logo` serves to anyone, and only the platform operator's route writes it.
-- A logo is at most 256 KB, so it lives here rather than in the upload store: it is backed up with
-- the database and survives a deployment that has no UPLOAD_DIR.

CREATE TABLE "PlatformAsset" (
    "key" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "version" TEXT NOT NULL,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformAsset_pkey" PRIMARY KEY ("key")
);

-- Stated explicitly for the same reason as in 0009: default privileges belong to whoever ran 0008.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_api') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "PlatformAsset" TO app_api;
  END IF;
END $$;
