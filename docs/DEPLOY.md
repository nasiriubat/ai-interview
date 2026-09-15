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
    │           postgres            │◀──│ backup │ nightly pg_dump
    └───────────────────────────────┘   └────────┘
```

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

# 3. Build and start. First build compiles the whole workspace twice (API image, web image).
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

**OpenRouter serves no embedding models.** If OpenRouter is your only provider, that fallback is
where you will stay. To get semantic clustering, add a second provider with a direct key that does
serve them (OpenAI or Voyage) and route `embedding` to it. Everything else can stay on OpenRouter.

## Where the data lives

Four named Docker volumes, all on this host's disk, under `/var/lib/docker/volumes/`:

| Volume                | Holds                                   |
| --------------------- | --------------------------------------- |
| `deploy_pgdata`       | The database. Everything that matters.  |
| `deploy_backups`      | Nightly `pg_dump` files.                |
| `deploy_caddy_data`   | TLS certificates and ACME account keys. |
| `deploy_caddy_config` | Caddy's autosaved config.               |

The prefix is the compose project name, which defaults to the directory holding the compose file
(`deploy`). `docker volume ls` shows the real names.

Every container that faces the network runs unprivileged: the API, the worker and the web app all
run as uid 1000 (`node` in the API image, `app` in the web image) over a root-owned, read-only
application tree. Confirm with `dc exec api id`.

`deploy/.env` is the fifth thing that matters and it is not in a volume. It is mode 600 in the
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

`backup` takes a `pg_dump --format=custom --compress=6` every night at `BACKUP_AT` (default 03:20,
container clock, UTC) into the `backups` volume, deletes dumps older than `BACKUP_RETENTION_DAYS`
(default 14), and logs one line per run. Because it shares the server's image, `pg_dump` can never
drift from the server version.

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
