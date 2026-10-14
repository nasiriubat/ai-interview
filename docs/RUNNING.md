# Running the platform locally

For deploying to a server, see [DEPLOY.md](DEPLOY.md); this file is development only.

Prerequisites: Node 22, pnpm 10, Docker.

## The whole stack in Docker

```bash
cp apps/api/.env.example apps/api/.env   # fill PLATFORM_ENCRYPTION_KEY and AUTH_SECRET
pnpm stack:up      # build and start everything; web on http://localhost:3000, mail on :8025
pnpm stack:logs    # follow api, worker and web
pnpm stack:down    # stop; the database and uploads are kept
pnpm stack:clean   # stop and delete this project's images and stale layers (volumes are kept)
```

This builds two images, `aidp-server` and `aidp-web`. The `migrate`, `api` and `worker`
containers all run `aidp-server` with different commands, so Docker holds one copy of the server
rather than three (D-74). `stack:up` also prunes the untagged layers each rebuild leaves behind,
filtered to this project, so the image list does not grow with every build.

### Against a scripted model (no keys, no internet)

```bash
docker compose -f docker-compose.yml -f docker-compose.fake.yml up -d --build
node deploy/drill/configure.mjs     # AIDP_* variables: deploy/drill/stack.sh env prints them
```

`docker-compose.fake.yml` adds `tools/fake-provider`, an OpenAI-compatible server with scripted
interviews, and lets the API and worker reach it. `configure.mjs` then does what an operator would
in the admin: it creates the provider, prices it and routes every purpose to it. The control
endpoint (`http://localhost:14010/__control`: latency, error rate, 429s, hangs) and the alert sink
(`/__sink`) are for trying failure by hand. The production-shaped rehearsal, with Caddy and the
backup, is in [DEPLOY.md](DEPLOY.md#rehearsing-a-deployment).

## Running on the host

For working on the code with hot reload, run only Postgres in Docker:

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

`pnpm check` runs format, build, typecheck, lint and every package's tests, cheapest first. It
needs a database, because the integration suites (the whole API end-to-end suite, the
row-level-security conformance tests, and part of `packages/core` and `apps/worker`) are part of
the gate. Without `DATABASE_URL` it refuses to start and says how to get one. With a database, a
single skipped test fails the run.

```bash
pnpm db:up                       # pgvector container, migrations; prints the DATABASE_URL to export
export DATABASE_URL=postgresql://app:app@localhost:5432/ai_discovery
pnpm check
```

`pnpm check --no-db` runs everything except the database-backed suites, ends with a banner
("SKIPPED: N db tests ... does not satisfy the quality gate") and records the run in
`.check-state.json`. It is for a quick local loop, and it is not what CI runs. Suites declare
their need with `describeDb` from `@aidp/testing`: it runs with a database, skips visibly under
`--no-db`, and otherwise fails the file.

Tests never reach the network. A setup file loaded by every package's Vitest config makes `fetch`
and raw sockets to anything but loopback (and the database host) throw "network access in tests",
and a canary test in each package proves the guard is live.

To give the suites their own database rather than the development one:

```bash
docker exec ai-interview-postgres-1 psql -U app -d postgres -c 'CREATE DATABASE ai_discovery_test'
export DATABASE_URL=postgresql://app:app@localhost:5432/ai_discovery_test
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

## Voice

Answering by recording needs a `transcription` route. A live conversation needs that plus a `tts`
route, and the tenant setting `features.realtimeVoice`, which ships off.

Neither Anthropic nor OpenRouter can transcribe, speak or embed. Setting `OPENAI_API_KEY` in
`apps/api/.env` bootstraps a platform OpenAI provider routed to exactly those three purposes and
nothing else, which is the shortest path to a working voice interview and to semantic clustering
in the analysis.

The live session is a WebSocket at `/api/v1/p/session/live` on the API. It is the one browser call
that does not go through the Next.js proxy, because a route handler cannot upgrade a connection;
in production Caddy forwards that single path. Running the web app on :3000 against the API on
:4000, set `NEXT_PUBLIC_VOICE_WS_URL=ws://localhost:4000/api/v1/p/session/live`.

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
