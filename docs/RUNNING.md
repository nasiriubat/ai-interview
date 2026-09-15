# Running the platform locally

For deploying to a server, see [DEPLOY.md](DEPLOY.md); this file is development only.

Prerequisites: Node 22, pnpm 10, Docker.

```bash
docker compose up -d postgres            # Postgres 16 with pgvector on localhost:5432
pnpm install
pnpm -r build
cp apps/api/.env.example apps/api/.env   # fill PLATFORM_ENCRYPTION_KEY (openssl rand -base64 32) and AUTH_SECRET
export DATABASE_URL=postgresql://app:app@localhost:5432/ai_discovery
pnpm --filter @aidp/db migrate:deploy
BOOTSTRAP_OPERATOR_EMAIL=you@example.com BOOTSTRAP_ADMIN_EMAIL=you@example.com \
  PLATFORM_ENCRYPTION_KEY=<same as .env> ANTHROPIC_API_KEY=sk-ant-... \
  pnpm --filter @aidp/db bootstrap
pnpm --filter @aidp/api dev              # API on http://localhost:4000, OpenAPI at /api/v1/openapi.json
pnpm --filter @aidp/worker dev
pnpm --filter @aidp/web dev              # web app on http://localhost:3000
```

## Tenancy: connect as the unprivileged role

Row-level security is the second fence (FR-01, NFR-03) and it only holds when the application
connects as `app_api`, which owns nothing and cannot bypass a policy. The owner role keeps
running migrations and seeds.

```bash
APP_DB_PASSWORD=<a strong password> \
  BOOTSTRAP_OPERATOR_EMAIL=you@example.com BOOTSTRAP_ADMIN_EMAIL=you@example.com \
  PLATFORM_ENCRYPTION_KEY=<same as .env> pnpm --filter @aidp/db bootstrap
# then point the API and the worker at that role, leaving migrations on the owner:
DATABASE_URL=postgresql://app_api:<password>@localhost:5432/ai_discovery
```

Connected as the owner everything still works, because the owner bypasses policies — which is
exactly the failure mode to avoid in production, since nothing looks wrong. To check which role
is in force: `select current_user;` from the API's connection, or run the conformance tests
(`pnpm --filter @aidp/db test`), which connect as `app_api` and assert that a cross-tenant read
returns nothing and a cross-tenant write is refused by Postgres.

## Checks

`pnpm check` runs build, typecheck, lint and tests. The unit suites need nothing. The integration
suites — the whole API end-to-end suite, the row-level-security conformance tests, and part of
`packages/core` — **skip silently** without `DATABASE_URL`, so a green `pnpm check` on a machine
that never set it has not run them. Give them their own database:

```bash
docker exec ai-interview-postgres-1 psql -U app -d postgres -c 'CREATE DATABASE ai_discovery_test'
export DATABASE_URL=postgresql://app:app@localhost:5432/ai_discovery_test
export PLATFORM_ENCRYPTION_KEY=$(openssl rand -base64 32)
pnpm --filter @aidp/db exec prisma migrate deploy
pnpm check
```

A separate database, not the development one, for two reasons. The suites reset `app_api`'s
password so they can connect as it, which disconnects a running stack that uses that role. And a
failed run can leave test companies behind, which is noise you do not want in the data you are
demonstrating from.

## Uploads

Recorded audio and attached documents are bytes, not rows, so they need somewhere to live.
`docker compose up` mounts a named volume at `/uploads` for the API and the worker and sets
`UPLOAD_DIR` to it. Running the API on the host with `pnpm dev` and no `UPLOAD_DIR` keeps them in
memory instead, which is fine for a quick test and loses every upload when the process restarts.
The readiness endpoint reports which store is in force.

Reading a file needs model routes for `file_ingest` and, for images, `vision_ingest`. Recorded
voice needs one for `transcription`. Without them an upload is accepted and then marked failed,
which is visible to the participant.

Provider configuration without an Anthropic key: sign in as the operator, add a provider
(OpenAI, OpenRouter, LiteLLM, or any OpenAI-compatible server), fetch its models, and set
routes per purpose. Nothing works until `interview_turn` has a route.

Bootstrap providers: `ANTHROPIC_API_KEY` creates a platform Anthropic provider with default
routes; `OPENROUTER_API_KEY` creates a platform OpenRouter provider (Claude models through
`vendor/model` slugs, prices imported from OpenRouter's model list). When both are set the
Anthropic routes win; the OpenRouter routes fill only purposes without a route.

Requirements interviews (phase 3) also need routes for `issue_detection` (the separate
findings pass, every few turns) and `spec_generation` (versions, run by the worker). Both
bootstraps set them. Pushing a version to GitHub asks for a token with `contents:
write` on the target repository at push time; the token is used for one commit and never stored.
