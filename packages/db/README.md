# @aidp/db

Prisma schema for spec v1.1 section 9, migrations, tenant-scoped client, seeds.

- `pnpm migrate:dev` applies migrations to `DATABASE_URL` (start Postgres with `docker compose up -d` at the repo root; pgvector is required, the compose file uses the `pgvector/pgvector:pg16` image).
- `pnpm seed` loads the two platform templates from `seeds/templates/` (FR-65) and Anthropic seed prices when a platform Anthropic provider exists.
- `forCompany(prisma, companyId)` returns a client that injects `companyId` into every query on tenant-owned models. Migration `0002_rls` adds Postgres row-level security for the `app_api` role as a second fence: the API sets `app.company_id` per request transaction.
