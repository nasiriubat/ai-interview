# Deploying to a single VPS

For one person, once, on a fresh EU virtual machine with a domain already pointing at it. It
covers a pilot: real employee interview data, one host, unattended between check-ins. It does not
cover a multi-host production estate — see [What this deliberately does not
cover](#what-this-deliberately-does-not-cover).

For local development read [RUNNING.md](RUNNING.md) instead. The two stacks are separate files on
purpose: `docker-compose.yml` publishes Postgres on 5432 and runs a mail catcher, and a compose
overlay can neither unpublish a port nor delete a service, so production gets its own file that
can be read top to bottom and believed.

## What you end up with

```
        internet
           │  :80 → :443 (redirect), :443
    ┌──────▼──────┐
    │    caddy    │  the only container that publishes a port
    └──────┬──────┘  TLS from Let's Encrypt, renewed automatically
           │ http
    ┌──────▼──────┐
    │     web     │  Next.js; holds the session cookie
    └──────┬──────┘
           │ http, internal network only
    ┌──────▼──────┐        ┌────────┐
    │     api     │        │ worker │  pg-boss consumers
    └──────┬──────┘        └───┬────┘
           │  as app_api       │  as app_api
    ┌──────▼───────────────────▼────┐   ┌────────┐
    │           postgres            │◀──│ backup │ nightly pg_dump + uploads
    └───────────────────────────────┘   └────────┘
                  uploads volume ───────────┘  (audio and attached documents)
```

Images: `aidp-server` runs `migrate`, `api` and `worker`; `aidp-web` runs `web`; the stock
`pgvector/pgvector:pg16` runs `postgres` and the three one-shot database helpers (`db-grants`,
`preflight`, `backup`); `caddy:2-alpine` runs Caddy. Four images for nine services.

**The API is not on the internet.** The browser never calls it: every request goes to a Next.js
route handler (`apps/web/src/app/api/**`), which attaches the bearer token server-side
(`apps/web/src/lib/api/proxy.ts`) and streams the response back, SSE included. Publishing the API
on its own hostname would add a second internet-facing origin to CORS-configure and rate-limit,
and would put tokens in the browser, for no capability the product uses. So the web app's
`API_URL` is `http://api:4000` — a name on the compose network — and nothing else resolves it.

## Prerequisites

- A VPS in the EU (NFR-02). 2 vCPU, 4 GB RAM, 40 GB disk is the floor; the resource limits in
  `deploy/compose.prod.yml` are sized for that. Postgres and the two Node services are the
  memory-hungry parts.
- Docker Engine 24+ with the Compose plugin. `docker compose version` must work.
- A DNS `A` record (and `AAAA` if the host has IPv6) for your hostname pointing at the VPS, already
  resolving. Caddy cannot get a certificate before this is true.
- Inbound TCP 80 and 443 open. Port 80 is not optional — ACME's HTTP challenge uses it, and it is
  what redirects visitors to HTTPS.
- An SMTP relay you can send from. Sign-in is a magic link; without a relay nobody can log in.
- Git, to clone the repository onto the host. The images are built on the VPS from the checkout.

## First deployment

Seven commands. Run them as a user in the `docker` group, from the repository root.

```bash
git clone <your-remote> ai-interview && cd ai-interview

# 1. Secrets and settings. Writes deploy/.env, mode 600. Refuses to overwrite an existing file.
./deploy/generate-env.sh pilot.example.com ops@example.com

# 2. Fill in the one thing it cannot invent. Sign-in is broken until this points at a real relay.
#    (And if you have an ANTHROPIC_API_KEY or OPENROUTER_API_KEY, add it now so first boot seeds
#    a provider with default routes; you can also do it in the admin UI later.)
$EDITOR deploy/.env          # set EMAIL_SMTP_URL=smtp://user:pass@relay.example.com:587

# 3. Build and start. Two images are built: aidp-server (migrate, api and worker all run it,
#    with different commands) and aidp-web. See D-74. The web build downloads the Inter font
#    from Google Fonts once and serves it from your own origin, so the build host needs outbound
#    HTTPS; the running site never contacts Google.
docker compose -f deploy/compose.prod.yml --env-file deploy/.env up -d --build

# 4. Watch it come up. Every service should reach (healthy).
docker compose -f deploy/compose.prod.yml --env-file deploy/.env ps

# 5. Confirm the two gates passed.
docker compose -f deploy/compose.prod.yml --env-file deploy/.env logs preflight db-grants

# 6. Confirm the operator exists and the schema is at head.
docker compose -f deploy/compose.prod.yml --env-file deploy/.env logs migrate | tail -3
```

Step 5 should print exactly this, and the stack will not have started if it did not:

```
preflight: ok — connected as app_api, no bypass, 15 tables under RLS, CREATE on database, untenanted reads return nothing
```

Step 6 ends with the bootstrap line naming your operator, tenant and admin:

```
bootstrap: operator ops@example.com, tenant "First tenant" admin ops@example.com, templates 2, ...
```

Now open `https://pilot.example.com/auth/signin`, enter the operator address, and follow the magic
link from your inbox. Nothing will run an interview until `interview_turn` has a model route —
add a provider and set routes in the admin UI (see RUNNING.md, "Provider configuration").

Because the commands are long, the rest of this document uses:

```bash
alias dc='docker compose -f deploy/compose.prod.yml --env-file deploy/.env'
```

## Model configuration, and the one route that is easy to miss

The platform routes each _purpose_ — `interview_turn`, `extraction`, `summarize`, `analysis`,
`report`, `embedding`, and the phase 3 spec purposes — to a model independently, so a cheap model
can drive the conversation while a stronger one writes the report. Admin → Providers adds a
provider and imports its model list from the provider's own API; Admin → Routing binds purposes to
models; Admin → Settings holds the defaults.

`interview_turn` is the one that blocks everything: with no route, no interview can start.

`embedding` is the one that fails quietly. Analysis clusters findings by semantic similarity, and
with no embedding route it falls back to lexical overlap — the run succeeds, the report is
produced, and the clusters are simply worse, grouping on shared words rather than shared meaning.
The pipeline records which path it took, so check it after your first analysis.

**Recorded voice answers work with no key at all (D-75).** Bootstrap always adds a platform
provider called "On this server (Whisper)", of kind `local`, and routes `transcription` to it
unless something else already has that route. The API runs Whisper on its own CPU, so the audio
never leaves the VPS and transcription costs nothing; the ledger still records each call, at zero.

- **First transcription downloads the model.** whisper-small at q8 is about 250 MB, fetched from
  Hugging Face into the `models` volume (`MODEL_CACHE_DIR=/models`). The API starts that download
  in the background as soon as it boots, so normally nobody waits for it. Watch it with
  `curl -s https://<domain>/api/v1/health/ready`: `speech.state` goes `downloading` (with
  `progress`) → `ready`. It never makes readiness fail. Offline at boot? The API starts anyway,
  logs `local speech: model did not load`, and the next recording tries again. After the first
  download the server needs no network for it.
- **Memory.** The API process holds the model on a worker thread: measured at about 0.9 GB resident
  once loaded and 1.6–2.0 GB while transcribing. It is released after
  `SPEECH_MODEL_IDLE_MINUTES` (default 10) without a recording and reloaded from the volume in
  about a second when the next one arrives, so an idle server does not hold it; set it to `0` to
  keep the model loaded permanently. Give the `api` service at least 2.5 GB; on a
  4 GB VPS that is fine alongside Postgres and the web app, on a 2 GB VPS it is not — route
  transcription to OpenAI instead (below) and the model is never loaded.
- **CPU.** One recording at a time, queued. A 10-second answer takes about a second on a laptop
  core and a few seconds on a 2-vCPU VPS. A recording that waits more than two minutes to start
  (a backlog, or the first download still running) gets a "try again in a minute", and its audio
  is kept.
- **Choosing the model** is the route's model field in Admin → Routing: `onnx-community/whisper-small`
  (default, good Finnish), `onnx-community/whisper-base` (faster, 80 MB, weaker Finnish) or
  `onnx-community/whisper-large-v3-turbo` (best, about 1.1 GB and 4+ GB of RAM). Only these three
  run; anything else is refused, so a tenant's route cannot make the server download arbitrary
  models. One model is held at a time.
- **Switching to OpenAI.** Point the `transcription` route at an OpenAI provider (whisper-1) in
  Admin → Routing, platform-wide or per tenant. The local provider stays in the list to switch back.

**Neither Anthropic nor OpenRouter can speak or embed.** Anthropic has no audio or embedding
endpoints, and OpenRouter proxies chat models only. Without a third key you get interviews that
work, recorded answers transcribed on the server, clustering that falls back to word overlap, and
no spoken interviewer.

Setting `OPENAI_API_KEY` in `deploy/.env` closes all three at once: first boot adds a platform
OpenAI provider and routes `transcription`, `stt_stream`, `tts` and `embedding` to it, leaving every
conversation purpose on whichever provider you chose. Transcription then goes to OpenAI rather
than the local model; the local provider is still created, so you can switch back.

| Purpose         | Default model            | What it turns on                          |
| --------------- | ------------------------ | ----------------------------------------- |
| `transcription` | `whisper-1`              | Voice answers, and live voice             |
| `stt_stream`    | `gpt-live-transcribe`    | Live captions while the participant talks |
| `tts`           | `tts-1`                  | The interviewer's own voice               |
| `embedding`     | `text-embedding-3-small` | Semantic clustering instead of keywords   |

The cheaper models are chosen deliberately: a voice interview pays per second of conversation.
Change a row in Admin → Routing for a better voice.

## Who may connect to what, and what may connect out

Three settings carry the network-facing security decisions; the defaults are right for the
single-host layout in this document and each is a stated number or list rather than a switch.

- **`TRUST_PROXY_HOPS`** (API, default `1`). How many proxies between the internet and the API
  write `X-Forwarded-For`. Caddy is one: for ordinary calls it writes the client address, the web
  app forwards that single value, and for the live-voice socket Caddy talks to the API directly.
  Caddy overwrites the header from the connection (`header_up X-Forwarded-For {remote_host}`),
  so a client cannot choose its own rate-limit bucket. Put another proxy or a CDN in front and
  this number has to change with it; a wrong value either lumps every visitor into one bucket or
  lets one visitor pick theirs. IPv6 clients are limited by their /64.
- **`EGRESS_ALLOW_HOSTS`** (API and worker, default empty). The API connects out to model
  providers and mail relays that admins name. A **tenant** admin's address must be `https`, a
  public DNS name, port 443 or 8443, and may not resolve to a loopback, private, link-local or
  cloud-metadata address; this is checked on every connection, not only when it is saved. The
  **platform operator** may use `http` and may reach a private address only for the hostnames
  listed here (for instance a LiteLLM container named `litellm`). Leave it empty unless you run
  a model server inside this compose network. The metadata addresses (`169.254.169.254` and its
  relatives) are refused whatever you list. `EGRESS_MODE=permissive` exists for tests and the API
  refuses to start with it in production.
- **Request size.** Caddy refuses a body over 2 MB, except the two upload paths at 55 MB; the web
  app and the API apply the same ceilings, and a tenant's `files.maxSizeMb` (at most 50) is
  enforced before the file is read. Slow clients are cut off after 10 s of headers or 3 minutes of
  body.

Sign-in relay (`EMAIL_SMTP_URL`) is yours and is not restricted. An SMTP relay a tenant types in
Admin → Settings is: a public name, port 465, 587 or 2525, TLS required.

## Live voice

A live voice interview is the one browser call that does not go through the Next.js proxy. A route
handler cannot upgrade a connection, so `deploy/Caddyfile` forwards exactly
`/api/v1/p/session/live` to the API and everything else to the web app. The API authenticates it
with the same `aidp_participant` cookie the web app set, so the socket grants nothing an ordinary
HTTP call would not.

It is off until a tenant turns it on, from the **Live voice calls** switch at the top of Admin →
Settings → Voice. The panel shows whether the three voice purposes have a working route and where
it comes from. The call needs `transcription` and `tts`; if either is missing, turning the switch
on asks the admin for an OpenAI API key, checks it with one free request, stores it encrypted as
the tenant's OpenAI provider and routes the missing purposes to it (audited as
`voice.openai_connect`), then switches live voice on. With a platform `OPENAI_API_KEY` nobody is
asked for anything. `OPENAI_BASE_URL` in the API's environment points that key check and provider
somewhere other than `https://api.openai.com/v1`, for a regional endpoint or a proxy.

With an `stt_stream` route the call streams: the browser sends 24 kHz PCM continuously (about
48 kB/s per call, so allow for it on a thin uplink), the API holds one outbound WebSocket per call
to `wss://api.openai.com/v1/realtime?intent=transcription`, and captions grow while the participant
speaks. The API container needs outbound WebSocket access to OpenAI for that, as it already needs
HTTPS. If the streaming socket cannot be opened or drops mid-call, the call carries on per
utterance through `transcription`.

Without the required routes it degrades rather than breaking, and which rung it drops to depends on
what is missing:

| What is missing             | What the participant gets                                  |
| --------------------------- | ---------------------------------------------------------- |
| Streaming captions failing  | Captions per utterance, when the participant stops         |
| No `tts` route              | The call continues in captions, without the spoken voice   |
| A transcription that failed | The push-to-record button, worth retrying by hand          |
| No `transcription` route    | Typing. Nothing that listens can work, so nothing pretends |
| Transcription on the server | The push-to-record button, which does work (see below)     |

The interview itself is untouched in every case.

The on-server Whisper (the default `transcription` route) reads WAV only. The record button
converts each recording to WAV in the browser before uploading it; live voice streams WebM
utterances and does not, so with the default route a live call steps down to the record button on
the first utterance. For a live call that stays live, route `transcription` to OpenAI.

Costs run per second of conversation rather than per turn, which is worth knowing before opening
it to a whole department. The per-call figures land in the same cost ledger as everything else.

## Where the data lives

Five named Docker volumes, all on this host's disk, under `/var/lib/docker/volumes/`:

| Volume                | Holds                                                  |
| --------------------- | ------------------------------------------------------ |
| `deploy_pgdata`       | The database. Everything that matters.                 |
| `deploy_uploads`      | Recorded audio and attached documents (FR-30, FR-31).  |
| `deploy_backups`      | Nightly `pg_dump` files and the matching file archive. |
| `deploy_caddy_data`   | TLS certificates and ACME account keys.                |
| `deploy_caddy_config` | Caddy's autosaved config.                              |

`deploy_uploads` is the one people forget. Participants' recordings and the documents they attach
live there, not in Postgres, so a database-only backup would restore a system whose `Attachment`
rows all point at bytes that are gone — and nothing would say so until somebody pressed play. The
nightly job takes both, stamped identically, and `restore.sh` puts both back.

The prefix is the compose project name, which defaults to the directory holding the compose file
(`deploy`). `docker volume ls` shows the real names.

Every container that faces the network runs unprivileged: the API, the worker and the web app all
run as uid 1000 (`node`, in both images) over a root-owned, read-only
application tree. Confirm with `dc exec api id`.

`deploy/.env` is the sixth thing that matters and it is not in a volume. It is mode 600 in the
checkout, `.gitignore`d, and **not** baked into any image — the root `.dockerignore` excludes every
`.env` from the build context, and the images take their configuration from compose `environment:`
entries at run time. Back `deploy/.env` up somewhere other than this VPS: a database dump without
`PLATFORM_ENCRYPTION_KEY` cannot decrypt the provider keys or SMTP settings inside it.

## Database roles

Row-level security is the second tenancy fence (FR-01, NFR-03) and it only holds when the
application connects as `app_api`, which owns nothing and has no `BYPASSRLS`. The owner role
bypasses every policy, and when it does, nothing looks wrong — the app works, tests pass, and
tenant data leaks only once two tenants exist. That is the failure this deployment is built to
make impossible:

- `api` and `worker` have `postgresql://app_api:...` written literally into
  `deploy/compose.prod.yml`. Only the password comes from the environment, so there is no variable
  an operator can point back at the owner.
- `migrate` keeps the owner URL, because only the owner may change the schema, and it is handed
  `APP_DB_PASSWORD` so `bootstrap` gives `app_api` a login.
- `preflight` runs between them and refuses to let `api` or `worker` start unless it can prove, on
  a live connection, that: the URL names `app_api`, `current_user` agrees, the role has neither
  `rolsuper` nor `rolbypassrls`, thirteen tables have RLS enabled, the role can read the job
  queue, and an untenanted connection sees **zero** `User` rows. A stack that would have run on
  the owner does not start at all.

To check which role is in force on a running system:

```bash
dc exec -T postgres psql -U app -d ai_discovery \
  -c "select usename, count(*) from pg_stat_activity where datname='ai_discovery' and usename is not null group by 1;"
```

Healthy output — one `app` row is your own psql session:

```
 usename | count
---------+-------
 app     |     1
 app_api |    11
```

If you ever see the application's connections under `app`, stop the stack. `dc logs preflight`
will say which assertion failed.

Two runtime privileges were found by actually running the production stack rather than by reading
the schema. The first, pg-boss needing `CREATE` on the database, is migration
`0010_app_role_runtime_grants` and needs nothing from you: PostgreSQL checks that privilege before
it evaluates `CREATE SCHEMA IF NOT EXISTS`, so the API crash-loops without it. `CREATE` on a
database means "may create schemas in it" and nothing more; `app_api` still has no `BYPASSRLS` and
still owns no application table.

The second cannot be a migration, because it repairs state only a restore can produce, at a moment
when migrations have already run: `pg_restore` returns the pg-boss tables under the owner role with
nothing granted to `app_api`, and the API dies on "permission denied for table version". That is
what `deploy/grants.sql` and the `db-grants` service are for. It is idempotent and a no-op on a
healthy system.

## Backups

`backup` runs every night at `BACKUP_AT` (default 03:20, container clock, UTC) into the `backups`
volume, deletes files older than `BACKUP_RETENTION_DAYS` (default 14), and logs one line per run.
Because it shares the server's image, `pg_dump` can never drift from the server version.

Each run writes two files with the same timestamp:

| File                        | What                                                 |
| --------------------------- | ---------------------------------------------------- |
| `ai_discovery-<stamp>.dump` | `pg_dump --format=custom --compress=6`               |
| `uploads-<stamp>.tar.gz`    | Everything in the uploads volume at that same moment |

The pair matters. Restoring a dump next to a file archive from a different night gives you rows
and bytes that disagree, so `restore.sh` looks for the archive whose stamp matches the dump and
tells you plainly when there is not one.

```bash
dc logs backup --tail 20                                  # what it has been doing
dc exec -T backup ls -lh /backups                          # what it has
dc exec -T backup /usr/local/bin/backup.sh once            # take one now
```

### The volume is on this machine

`deploy_backups` lives on the same disk as `deploy_pgdata`. A dropped table it saves you from; a
dead host, a deleted VPS or a ransomwared filesystem it does not. **Offsite copies are your job.**
One concrete arrangement, roughly five minutes of work: create a storage bucket at a second EU
provider, install [`rclone`](https://rclone.org) on the host, and add a root cron entry:

```cron
30 4 * * * docker run --rm -v deploy_backups:/backups:ro -v /root/.config/rclone:/config/rclone:ro \
             rclone/rclone:latest sync /backups remote:ai-interview-backups --max-age 30d
```

Then set a calendar reminder to restore one of those offsite copies into a scratch database every
quarter. An untested backup is a rumour.

## Restoring

`deploy/restore.sh` restores a dump into a target database. It refuses to overwrite a database that
still holds rows unless you pass `--force`, and it asks you to type the target database name before
it does anything.

```bash
./deploy/restore.sh                                     # list the dumps
./deploy/restore.sh --latest --into ai_discovery_check   # verify a dump, live stack untouched
./deploy/restore.sh --latest --force                     # disaster: restore over the live database
```

Restoring over `ai_discovery` stops `api` and `worker`, recreates the database, runs `pg_restore`,
then starts them again — which re-runs `migrate`, `db-grants` and `preflight` on the way back up.
That is deliberate: a dump older than the current code gets migrated forward, the runtime grants
are re-applied, and the role gate re-checks the result before traffic returns.

### The drill, as actually run

Performed against this exact compose file on 2026-09-14, Docker Desktop on an Apple-silicon laptop,
against a freshly bootstrapped database (3 companies, 3 users, 2 templates — a 124 KB dump).

```bash
# seed two rows a restore has to bring back
dc exec -T postgres psql -U app -d ai_discovery -c \
  "insert into \"Company\" (id, name, \"monthlyBudgetCents\") values ('drill-co-1','Restore Drill Oy',12345);
   insert into \"User\" (id, \"companyId\", email, role) values ('drill-user-1','drill-co-1','drill@example.com','admin');"

dc exec -T backup /usr/local/bin/backup.sh once

# destroy: drop the database out from under the running stack
dc exec -T postgres psql -U app -d postgres -c \
  "select pg_terminate_backend(pid) from pg_stat_activity where datname='ai_discovery' and pid<>pg_backend_pid();"
dc exec -T postgres psql -U app -d postgres -c "drop database ai_discovery;"

./deploy/restore.sh --latest --yes

# prove it
dc exec -T postgres psql -U app -d ai_discovery -c \
  'select (select count(*) from "Company") companies, (select count(*) from "User") users,
          (select name from "Company" where id='"'"'drill-co-1'"'"') drill_company;'
```

Measured:

| Step                                                                                                                      | Time    |
| ------------------------------------------------------------------------------------------------------------------------- | ------- |
| `backup.sh once` (124 KB dump)                                                                                            | 0.17 s  |
| `restore.sh --latest` end to end: stop, recreate, `pg_restore`, re-run migrate + grants + preflight, start api and worker | 5.1 s   |
| Cold boot from empty volumes to every service healthy, images already built                                               | 48–51 s |
| `docker compose build --no-cache`, both images, 605 packages installed from the registry                                  | 40 s    |

Result: `companies = 3`, `users = 3`, `drill_company = Restore Drill Oy`. `/api/v1/health/ready`
returned `{"ok":true,"database":true}`, the sign-in page returned 200 through Caddy, connections
were back on `app_api`, and after a further 90 seconds every container reported `RestartCount = 0`
and no permission errors. The drill was run twice, the second time against the final images.

These numbers are floors, not forecasts. They come from a laptop with a fast disk and a fast
network, against a database with a handful of rows in it. Restore time is dominated by
`pg_restore`, which scales with data volume; the first build on a modest VPS is dominated by
`pnpm install` and `tsc`, and several minutes there would be unremarkable. Budget minutes rather
than seconds, and measure your own restore into a scratch database before you need it.

### Refusals, also exercised

```
restore: refusing to overwrite 'ai_discovery', which still has 3 User rows.
         Restore into a scratch database first (--into ai_discovery_check) to verify the
         dump, or pass --force if you really mean to discard what is there.
```

```
preflight: FAIL: APP_DATABASE_URL does not connect as app_api
preflight: FAIL: app_api has rolsuper/rolbypassrls = false true, expected 'false false'
```

## Secrets you cannot casually rotate

`PLATFORM_ENCRYPTION_KEY` is the platform key that encrypts provider API keys and SMTP settings at
rest (`packages/core`, `Crypto`). It is not a password you can change on a whim: rotating it
without re-encrypting makes every stored secret undecryptable, and the symptom is not a clean
error but providers that fail at call time. **There is no supported rotation path yet.** If you
believe the key is compromised:

1. Sign in as the platform operator and write down which providers are configured.
2. Stop the stack, change `PLATFORM_ENCRYPTION_KEY` in `deploy/.env`, start it again.
3. Delete and re-enter every provider's API key through the admin UI, and re-enter any SMTP
   settings stored in the settings catalog. The old ciphertext is dead weight; nothing will read it.
4. Rotate the provider keys themselves at the provider, since the old ones were exposed.

Do not skip step 1: after the key changes you cannot read the old values back to know what to
re-enter.

`AUTH_SECRET` signs session JWTs and is shared by the web app and the API. Changing it is safe and
signs everyone out; both services must get the same new value, so change it in `deploy/.env` and
recreate both.

`POSTGRES_PASSWORD` and `APP_DB_PASSWORD` are ordinary passwords. To change `APP_DB_PASSWORD`, edit
`deploy/.env` and run `dc up -d --force-recreate`: `migrate` re-runs `bootstrap`, which applies the
new password to the role, and the app picks up the same value from the same variable.
`POSTGRES_PASSWORD` is set by the Postgres image only on first initialisation, so changing it later
also needs `dc exec postgres psql -U app -c "alter role app password '<new>'"` before the recreate.

Back up `deploy/.env`. A database dump without it is only half a backup.

## Upgrading

```bash
cd ai-interview
git pull
dc up -d --build
```

That is the whole upgrade. `--build` rebuilds any image whose inputs changed; compose recreates
only the containers whose image or configuration moved, and `depends_on` orders the restart:
`migrate` applies new migrations, `db-grants` re-applies runtime privileges, `preflight` re-checks
the role, then `api` and `worker` restart, then `web`, then `caddy`. Migrations run before the new
code serves traffic.

There is a gap of a few seconds where `api` is down and `web` returns errors. On one host, with one
replica of each service, that is the honest cost; a blue-green rollout needs a second host or a
second stack and is out of scope here.

Watch it land:

```bash
dc logs -f migrate preflight api
```

## Rolling back

Code and schema roll back differently, and the second one is the dangerous one.

**Code only** (the new release is bad, migrations were additive or there were none):

```bash
git log --oneline -5             # find the previous good commit
git checkout <previous-sha>
dc up -d --build
```

**Code and data** (a migration destroyed or transformed data):

```bash
./deploy/restore.sh                            # find the dump from before the upgrade
git checkout <the-sha-that-dump-was-taken-on>
dc up -d --build                               # get the old code in place first
./deploy/restore.sh <that-dump> --force        # then the old data
```

Order matters. Restoring an old dump under new code lets `migrate` roll it forward into exactly the
state you were trying to escape. Check out the old commit first.

Prisma migrations here are forward-only; there are no down migrations. The dump is the rollback.
Take one by hand before any upgrade you are unsure about:

```bash
dc exec -T backup /usr/local/bin/backup.sh once
```

## Reading the logs

```bash
dc logs -f                       # everything, live
dc logs -f api                   # one service
dc logs --since 1h api worker    # a window
dc logs api | grep -i error
```

The API and worker log structured JSON (pino). For readable output, pipe through `jq`:

```bash
dc logs --no-log-prefix api | grep '^{' | jq -c '{t:.time, lvl:.level, msg:.msg, req:.reqId}'
```

Caddy logs access in JSON on stderr; `dc logs caddy` shows every request with status and duration.

Every service uses the `json-file` driver capped at **3 files of 10 MB**, so container logs can
never consume more than about 180 MB across the stack. This is the single most boring way to lose a
pilot and it is the reason the cap is there.

## When the disk fills

Symptoms: Postgres refuses writes, the API returns 500s, `dc ps` looks fine.

```bash
df -h /                                  # how bad
docker system df                         # what Docker is holding
dc exec -T backup du -sh /backups        # how much is dumps
```

In order of what to try:

```bash
docker image prune -a -f                 # old images from previous builds; usually the biggest win
docker builder prune -f                  # BuildKit cache
dc exec -T backup sh -c 'ls -1t /backups/*.dump | tail -n +4 | xargs -r rm'   # keep the newest 3
```

Then lower `BACKUP_RETENTION_DAYS` in `deploy/.env` and `dc up -d backup`. If the database itself is
the size, that is a capacity decision, not a cleanup: grow the volume or move to a bigger host.
Check `dc exec -T postgres psql -U app -d ai_discovery -c "\l+"` for the real figure.

Set up a disk alert before you need one. Even a cron job that emails you at 80% is enough.

## Testing without a public domain

You cannot get a real certificate without a domain that resolves to the host, so Caddy is told to
issue from its own CA instead. Three variables in `deploy/.env`:

```bash
PUBLIC_HOSTNAME=localhost
CADDY_LOCAL_CERTS=1               # Caddy's internal CA instead of Let's Encrypt
HTTP_PORT=5580                    # optional: only if 80/443 are taken
HTTPS_PORT=5543
```

Then the ordinary commands work, with `curl -k` to accept the self-signed certificate:

```bash
dc up -d --build
curl -k -o /dev/null -w '%{http_code}\n' https://localhost:5543/auth/signin     # 200
```

**For a real domain, change exactly this and nothing else:** set `PUBLIC_HOSTNAME` to the hostname,
leave `CADDY_LOCAL_CERTS` empty, remove `HTTP_PORT`/`HTTPS_PORT` so Caddy binds 80 and 443, and put
a real address in `ACME_EMAIL` (Let's Encrypt sends expiry warnings there). Caddy then obtains a
certificate on first request and renews it on its own. Everything else — the proxying, the headers,
`WEB_ORIGIN`, `AUTH_URL`, `PUBLIC_WEB_URL` — is derived from `PUBLIC_HOSTNAME` and needs no edit.

If the certificate does not appear, the cause is almost always DNS or port 80:

```bash
dig +short pilot.example.com            # must be this host's IP
dc logs caddy | grep -i acme
```

## Before you go live

- [ ] DNS resolves to this host; `https://<hostname>/auth/signin` returns 200 with a certificate
      your browser trusts, and `dc logs caddy | grep -i "certificate obtained"` confirms it.
- [ ] `CADDY_LOCAL_CERTS` is empty and `HTTP_PORT`/`HTTPS_PORT` are unset.
- [ ] `dc logs preflight` says `ok`, and `pg_stat_activity` shows the app on `app_api`.
- [ ] A magic link actually arrives in a real inbox, from a real relay, and signs you in.
- [ ] A provider is configured and `interview_turn` has a route — take one interview end to end.
- [ ] If you want voice or semantic clustering, `OPENAI_API_KEY` is set and Admin → Routing shows
      `transcription`, `tts` and `embedding` bound to it. Without them voice degrades and analysis
      clusters on keywords; both are silent, so check rather than assume.
- [ ] If live voice is on, hold one real conversation on a phone, on mobile data, and interrupt the
      interviewer mid-sentence. Latency and barge-in are the two things a desk test will not show.
- [ ] Attach a document during an interview and confirm it reaches `Ready`, not `Failed`.
- [ ] `curl -s -o /dev/null -w "%{http_code}" -X POST --data-binary @<a 3 MB file> https://<hostname>/api/staff/campaigns`
      answers `413` from Caddy, and `TRUST_PROXY_HOPS` still matches the proxies you run.
- [ ] `pnpm audit --prod --audit-level=high` is clean on the commit you deployed.
- [ ] `dc exec -T backup ls -lh /backups` shows a dump, and you have restored one into
      `ai_discovery_check` and looked at the row counts.
- [ ] `deploy/.env` is copied somewhere off this host, and you know it contains
      `PLATFORM_ENCRYPTION_KEY`.
- [ ] Offsite backup copying is set up, or you have written down that it is not and accepted that.
- [ ] `ufw status` (or your provider's firewall) allows only 22, 80 and 443. Nothing but Caddy
      publishes a port, but a firewall is the fence you get to keep when compose changes.
- [ ] Unattended security upgrades are on for the host OS.
- [ ] `df -h` shows room, and something will tell you when it does not.
- [ ] Someone other than you knows this document exists.

## What this deliberately does not cover

- **Offsite backups.** The dumps sit on the same disk as the database. There is a suggestion above;
  wiring it up and testing it is yours.
- **Monitoring and alerting.** Health checks restart a wedged container, and that is all. Nothing
  pages anyone. `docs/spec/12-operations.md` describes the OpenTelemetry and Grafana Tempo setup
  the platform is built for; `OTEL_EXPORTER_OTLP_ENDPOINT` is wired through and empty by default.
- **Multi-host, high availability, zero-downtime deploys.** One host, one replica of each service,
  a few seconds of downtime per upgrade. Blue-green (`12-operations.md`) needs somewhere to be
  green.
- **Object storage.** MinIO is in the development stack under the `extras` profile. When voice and
  attachments land, they need a bucket and a backup story of their own.
- **Host hardening.** SSH keys, fail2ban, unattended-upgrades, kernel tuning — standard VPS work,
  no different here.
- **Database tuning.** `shared_buffers=512MB` and `max_connections=100` are defensible defaults for
  4 GB of RAM and no more than that.
