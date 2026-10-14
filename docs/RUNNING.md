# Running the platform locally

For deploying to a server, see [DEPLOY.md](DEPLOY.md); this file is development only.

Prerequisites: Node 22, pnpm 10, Docker.

## Configuration

One file configures development: the **root `.env`** (copy `.env.example`, which documents every
variable and tags it required, bootstrap, fallback or runtime). There is nothing to copy into
`apps/api` or `apps/web`.

| Where you run                                                | What reads the root `.env`                                              |
| ------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `pnpm stack:up` (Docker)                                     | every service, through `env_file`, and compose's own `${...}` expansion |
| `pnpm --filter @aidp/{api,worker,web} dev`, `@aidp/db` tools | `scripts/with-env.mjs`, which loads it before starting the command      |
| `pnpm check`, tests, `pnpm live:run`                         | tests never read it; `live:run` looks for the OpenRouter key in it      |
| Production                                                   | **not read.** `deploy/.env` (generated, every variable named) instead   |

**Precedence**, highest first: a variable set in the shell, then the root `.env`, then (only while
it still exists) the legacy `apps/api/.env`, then the code's default. In Docker, values the compose
file sets itself (`DATABASE_URL` to the `postgres` host, `EMAIL_SMTP_URL` to Mailpit, ports) win
over the file, so a host-style `DATABASE_URL=...localhost` in `.env` is correct for both.

**The values are a fallback, not the source of truth.** Once the platform is running the admin owns
configuration, and `.env` is what it starts from:

- _Bootstrap only:_ `BOOTSTRAP_*` (first operator, admin and tenant) and `ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `OPENROUTER_API_KEY` (seed the platform providers and their routes on first
  boot). They are not read again; change providers, routes and people in the admin.
- _Fallback for an admin setting:_ `EMAIL_SMTP_URL` and `EMAIL_FROM` are used only while the
  settings `email.smtpUrl` and `email.from` are empty at both tenant and platform scope.
- _Always from the environment:_ `PLATFORM_ENCRYPTION_KEY` (it decrypts everything the admin
  stores, so it cannot live in the admin), `AUTH_SECRET`, `DATABASE_URL`, ports and origins,
  egress and timeouts, alert targets.

Keep `.env` as the record of those first values, and back it up with the database: the encryption
key in it is what makes the database's stored secrets readable.

**Upgrading from `apps/api/.env`.** Run `pnpm env:migrate` (add `--dry-run` first). It copies keys
that are missing or empty in `.env`, never overwrites a value `.env` already has, keeps a
`.env.bak`, and prints key names only. Until you run it, `pnpm stack:up` and the dev scripts keep
reading the old file underneath the root one and warn; `pnpm stack:up` refuses to start only when an
empty `KEY=` in `.env` would hide a value that just the old file sets. Delete `apps/api/.env` afterwards.

## The whole stack in Docker

```bash
cp .env.example .env                     # fill PLATFORM_ENCRYPTION_KEY and AUTH_SECRET
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

The production-shaped rehearsal runs the whole stack against `tools/fake-provider`, an
OpenAI-compatible server with scripted interviews and a control endpoint for latency and failure
injection: see [DEPLOY.md](DEPLOY.md#rehearsing-a-deployment) (`deploy/drill/stack.sh`).

## How the first admin signs in

Locally, sign-in links are caught by Mailpit: `pnpm stack:up` starts it and the link is in the
inbox at `http://localhost:8025`. Without the Docker stack the web app falls back to
`smtp://localhost:1025` in development only.

Mailpit is not part of a production deployment. There the relay is a real SMTP server set at deploy
time as `EMAIL_SMTP_URL` in `deploy/.env` (required by `compose.prod.yml`), the first admin is
`BOOTSTRAP_ADMIN_EMAIL`, and Google sign-in (`AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`) is the
alternative. Tenant admins can then set their own mail server under Settings, Email, which covers
the mail a tenant sends but not the deployment's sign-in links. The full explanation is in
[DEPLOY.md](DEPLOY.md#how-the-first-admin-signs-in).

## Running on the host

For working on the code with hot reload, run only Postgres in Docker:

```bash
docker compose up -d postgres            # Postgres 16 with pgvector on localhost:5432
pnpm install
pnpm -r build
cp .env.example .env                     # fill PLATFORM_ENCRYPTION_KEY (openssl rand -base64 32) and AUTH_SECRET
pnpm --filter @aidp/db migrate:deploy    # these scripts load the root .env themselves
pnpm --filter @aidp/db bootstrap         # first-run operator, tenant and providers, from .env
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
the root `.env` bootstraps a platform OpenAI provider routed to exactly those three purposes and
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
