# Operating the platform

For the person who runs the box, after it is installed ([DEPLOY.md](DEPLOY.md) is the install).
Everything here is something the repository does or checks; the few things that are not in the
repository are listed in [What lives outside the box](#what-lives-outside-the-box).

Every command is run from the repository root on the VPS, and `deploy/dc` is `docker compose` for
this stack with the right files:

```bash
deploy/dc ps                       # what is running, and what is unhealthy
deploy/dc logs --tail 100 -f api   # one service
```

## The routine

| When                | What                                                                                                                                                    | How long |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| When an alert comes | Open its section in the [alert runbook](#alert-runbook). Each says what to look at, what to do and how you know it is fixed.                            | minutes  |
| Daily               | `deploy/dc ps`: nothing `unhealthy` or restarting. Operator → Background jobs: dead letters at 0.                                                       | 1 minute |
| Weekly              | `deploy/dc exec -T backup cat /ops-state/status/backup.json`: `lastResult` is `ok`, `offsite` is `ok` (or you have accepted that it is not configured). | 1 minute |
| Monthly             | `pnpm audit` in a checkout; host OS updates; look at Operator → Platform stats for spend; restore a backup into a scratch database (below).             | 30 min   |

Nothing in this list needs remembering to _look_ for a failure: failures are sent to you. The
routine is for the things that fail slowly.

## Alerts

### How an alert reaches you

Two paths, so that one outage cannot silence both.

1. **The application** raises alerts itself (`packages/core/src/alerts`): a budget is used up, a job
   is dead-lettered, the backup is missing, the disk is filling, a provider is failing. They are
   deduplicated in the `OpsAlert` table, so a condition that lasts a day is one message and a
   counter, and rate limited, so a flapping source ends in one "storm" notice and not a flooded
   phone.
2. **The `ops-notify` sidecar** (`deploy/ops/notify.sh`, its own tiny image) covers what the
   application cannot say about itself: the RLS preflight that refused to start it, a worker that
   cannot reach the queue, an API that is not answering, a certificate that is about to expire,
   and, while the worker is down, the backup and the disk. It needs no database and no application.

Both post to the same webhook and mail the same operator address.

**Set it up once**, in `deploy/.env`, and then `deploy/dc up -d ops-notify api worker`:

```bash
ALERT_EMAIL=you@example.com                     # empty falls back to the bootstrap operator
ALERT_WEBHOOK_URL=https://ntfy.sh/<a-long-random-topic>   # ntfy, or a Slack incoming webhook
ALERT_WEBHOOK_FORMAT=ntfy                        # ntfy | slack | generic
```

ntfy is the least effort: install the app, subscribe to the topic, done. Mail goes through the
platform's own SMTP relay (`EMAIL_SMTP_URL`), so a mail alert needs that relay to work: this is why
a webhook is worth having as well.

Once the application is running, **Admin → Settings → Operations alerts** (platform scope) takes
over from the environment and adds the dials: minimum severity per channel, how long before an
unresolved alert is sent again, the hourly ceiling, and the disk, provider and backup thresholds.
`deploy/.env` stays as the fallback and as what the sidecar reads.

### What a tenant is sent

Budget notices (at 80 and 90 percent of a budget, and when it is used up), three notices about
the tenant's own work (a campaign reached its completion threshold, an analysis is ready, a
specification version was generated), and the ceiling notices (a limit the operator set is at 80
percent or reached). They go to that tenant's own admins, or the list in `notifications.recipients`,
in the language `branding.language` names (English or Finnish). A tenant can switch off the budget
warning and each of the three work notices (`notifications.budgetWarnings`,
`notifications.campaignThreshold`, `notifications.analysisReady`, `notifications.specReady`) and
cannot switch off the exhaustion or ceiling notices. The three work notices are one mail per event:
their key is the id of the campaign, analysis or version. Nothing else is ever mailed to a tenant
admin, and an alert for one tenant is never sent to another's: the router resolves recipients from the alert's own `companyId`, and a kind the catalog
does not list for tenants cannot be addressed to them (`packages/core/test/alerts.test.ts`).

An alert never carries a transcript, an answer, a participant's address or an error message: ids,
counts and class names. Anything that looks like an address is replaced before the alert leaves the
box.

## Alert runbook

One section per kind in `packages/core/src/alerts/kinds.ts`; a test fails the build if one is
missing. Each alert's message ends with a pointer to its section here.

### budget.warning

**Symptom** A budget (a tenant's month, a campaign's cap) is at 80 or 90 percent. Interviews
continue. Sent to the operator's webhook and to the tenant's admins.

**Look at** Admin → Budgets for the scope named in the alert; Operator → Platform stats for the
month's spend by tenant.

**Do** Nothing is required. If the pace says it will run out before the month does, raise the
budget (Admin → Budgets) or tell the tenant. The tenant has been told already.

**Fixed when** The month rolls over or the limit is raised; the next warning is a new alert.

### budget.exceeded

**Symptom** A budget is used up. New turns under it are refused; the participant sees "paused",
and (if this alert was delivered) that the organizer has been notified. The tenant's admins and you
have both been told.

**Look at** Admin → Budgets, the scope in the alert. `deploy/dc exec -T postgres psql -U app -d
ai_discovery -c "select scope, \"scopeId\", \"limitCents\" from \"Budget\""`.

**Do** Raise the limit (the tenant's admin can, or you can for them), or leave it: it resets with
the month. Paused sessions resume on the participant's next message once there is budget. There is
deliberately no "fall back to a cheaper model" (D-91): the money is the tenant's to decide.

**Fixed when** The participant's next turn succeeds. The alert resolves itself when a new month
starts a new key.

### campaign.threshold

**Symptom** A tenant's campaign has enough completed interviews (`campaign.completionThreshold`
or the percentage rule) and its analysis was queued. Tenant admins only; you are not told.

**Look at** Nothing, unless the tenant says the mail did not arrive: Operator → Jobs for
`analysis.run`, and Settings → Notifications for the tenant's recipients.

**Do** Nothing. A tenant that sees none of these mails has switched
`notifications.campaignThreshold` off or has no admin with an address.

**Fixed when** There is nothing to fix; one campaign sends one of these, ever.

### analysis.ready

**Symptom** An analysis finished. Tenant admins only.

**Look at** The campaign's results page (the link in the mail). If a tenant says an analysis
finished and no mail came: the `analysis.run` job's log line "analysis done", then the tenant's
`notifications.analysisReady` and `notifications.recipients`.

**Do** Nothing.

**Fixed when** One mail per analysis id; a re-run is a new analysis and a new mail.

### spec.ready

**Symptom** A specification version was generated (`spec.generate`). Tenant admins only.

**Look at** The version's page (the link in the mail), and Operator → Jobs for `spec.generate`.

**Do** Nothing.

**Fixed when** One mail per version id.

### ceiling.warning

**Symptom** A tenant is at 80 percent of one of its ceilings (`ceiling.maxActiveCampaigns`,
`ceiling.maxSessionsPerMonth`, `ceiling.storageBytes`, `ceiling.voiceMinutes`). Interviews and
campaigns are still accepted. You and the tenant's admins are told.

**Look at** Operator → Tenants, the utilisation column for that tenant.

**Do** Nothing is required. If the tenant is growing as planned, raise the ceiling (Settings, the
tenant scope, category Ceiling; only the platform operator can write these keys).

**Fixed when** Usage falls under the line or the ceiling is raised; the next crossing is a new
alert. Monthly ceilings start a new key each month.

### ceiling.reached

**Symptom** A tenant used up a ceiling. Creating a campaign (`maxActiveCampaigns`) or starting an
interview (`maxSessionsPerMonth`) is refused with `limit_reached` until the ceiling is raised or the
month ends. Storage and voice minutes are reported but not yet refused. You and the tenant's admins
are told.

**Look at** Operator → Tenants, the utilisation column; the tenant's campaigns if the ceiling is
the active campaign count (a closed or archived campaign frees a place).

**Do** Raise the ceiling for the tenant, or tell them to close finished campaigns.

**Fixed when** The ceiling is raised or usage falls under it.

### job.dead_lettered

**Symptom** A background job failed its last attempt and sits in `<queue>.dead`. For `analysis.run`
the tenant sees "Analysis failed"; for `session.extract` facts are missing from a report; for
`email.send` a message was never delivered.

**Look at** Operator → Background jobs, then the queue named in the alert: the dead letter's ids and
last error. `deploy/dc logs --since 1h worker | grep <job id>` has the full error.

**Do** Read the error. If it was transient (a provider outage, a timeout), **Retry**: the job is
queued again with its original payload and a fresh set of attempts. If it can never succeed (the
session was deleted, the payload is wrong), **Discard**. A retried job that fails again comes back
here, with a new alert.

**Fixed when** The dead-letter count for the queue is back to 0, and the work shows in the product
(the analysis is done, the email arrived). Retrying or discarding resolves the alert.

### job.stuck

**Symptom** Jobs are `active` well past their time limit, so the queue's own maintenance, which
should have failed them, is not running. Work in that queue is not moving.

**Look at** Operator → Background jobs: active count against the time limit.
`deploy/dc logs --tail 100 worker` for `job queue error`; `deploy/dc ps` for the worker.

**Do** `deploy/dc restart worker`. Maintenance restarts with it, expires the stuck jobs and retries
or dead-letters them.

**Fixed when** The active count drops and the next sweep resolves the alert (within five minutes).
Check for a dead letter afterwards.

### backup.failed

**Symptom** The last backup run failed: `pg_dump` returned non-zero, the archive did not read back,
or the uploads archive could not be written. The backup container is `unhealthy`.

**Look at** `deploy/dc logs --tail 50 backup`, and the reason in
`deploy/dc exec -T backup cat /ops-state/status/backup.json`. Disk space (`df -h`, the
[`disk.high`](#diskhigh) alert) and Postgres health are the usual causes.

**Do** Fix the cause, then take one now: `deploy/dc exec -T backup /usr/local/bin/backup.sh once`.
Until a backup succeeds, **do not upgrade**: `upgrade.sh` refuses without a fresh one.

**Fixed when** `backup.sh once` exits 0 and the container is `healthy` again.

### backup.missing

**Symptom** There is no successful backup within the allowed age (26 hours by default), or the
backup container has never reported. The scheduler is stopped, was never started, or every run is
failing without the failure being recorded.

**Look at** `deploy/dc ps` (is `backup` running?), `deploy/dc logs --tail 50 backup`, and
`BACKUP_AT` in `deploy/.env`. A missing `BACKUP_AGE_RECIPIENT` makes compose refuse to start it,
with a message saying so (`deploy/ensure-backup-key.sh` creates one).

**Do** Start it (`deploy/dc up -d backup`), fix what its log says, and take one now as above.

**Fixed when** `/ops-state/status/backup.json` has a `lastSuccessAt` from the last few minutes.

### backup.offsite_failed

**Symptom** The local backup is good but copying it to `RCLONE_REMOTE` failed. There is no copy off
this host, which is the one failure a local backup cannot cover.

**Look at** `deploy/dc logs --tail 50 backup | grep -i rclone`. Credentials expired, bucket full,
or the endpoint unreachable. Test the remote by hand:
`deploy/dc exec -T backup rclone lsd "${RCLONE_REMOTE%%:*}:"`.

**Do** Fix the remote's credentials in `deploy/.env` (`RCLONE_CONFIG_OFFSITE_*`),
`deploy/dc up -d backup`, then `backup.sh once`.

**Fixed when** `status.offsite` is `ok` and the file is in the bucket.

### disk.high

**Symptom** The disk holding the database, the uploads and the backups is above 80 percent
(warning) or 90 (critical). At 100 Postgres stops accepting writes and the API returns 500s while
every container still looks fine.

**Look at** `df -h /`, `docker system df`, `deploy/dc exec -T backup du -sh /backups`.

**Do** In this order, stopping when it is enough: `docker image prune -a -f` (old images; keep the
current and previous version, which `upgrade.sh` records in `deploy/versions.env`),
`docker builder prune -f`, lower `BACKUP_RETENTION_DAYS` in `deploy/.env` and
`deploy/dc up -d backup`. If the database itself is the size, that is capacity: grow the volume or
move to a bigger host. Do not prune volumes.

**Fixed when** Use is under the warning threshold; the next sweep resolves it.

### provider.error_rate

**Symptom** A quarter or more of one provider's calls failed in ten minutes (at least ten calls).
Interviews on that provider are slow, failing or paused.

**Look at** `deploy/dc logs --since 15m api | grep provider_error`. The provider's status page.
Admin → Providers → Test for the key and model. Operator → Platform stats for the affected purpose.

**Do** If the provider is down, wait; calls are retried and time out at two minutes at most (so a
participant sees "temporarily unavailable" and not a hung screen). If it is a revoked or exhausted
key, replace it in Admin → Providers. If a model was retired, route the purpose to another in
Admin → Routing.

**Fixed when** The error share falls under the threshold; the next sweep resolves it.

### rls.preflight_failed

**Symptom** The row-level-security gate refused to start the stack: `api` and `worker` are not
running. This is the check that keeps one tenant's data from being readable by another, so it is
not bypassed, ever.

**Look at** `deploy/dc logs preflight`. It names what failed: a table with a `companyId` and no
policy, a role with `BYPASSRLS`, a connection that sees rows it should not.

**Do** A table named: a migration added it without its policy; fix the migration (copy the policy
from migration `0014`) and `upgrade.sh`, or [`rollback.sh`](#upgrade-and-roll-back) to the previous
version. A role problem: `deploy/dc logs migrate` and `docs/DEPLOY.md`, "Database roles". Never
change `DATABASE_URL` to the owner role to make it start.

**Fixed when** `deploy/dc logs preflight` ends with `preflight: ok` and `api` is healthy.

### tls.renewal

**Symptom** The certificate Caddy serves expires within 14 days, so renewal has been failing for
weeks without anyone knowing.

**Look at** `deploy/dc logs caddy | grep -i acme`. Almost always DNS no longer pointing at the host,
or port 80 blocked (ACME's HTTP challenge uses it).

**Do** Fix DNS or the firewall (`dig +short <hostname>` must be this host's address; 80 and 443
open). `deploy/dc restart caddy` retries immediately.

**Fixed when** `deploy/dc logs caddy | grep -i "certificate obtained"` shows a recent line; the
daily check clears the alert.

### audit.chain_broken

**Symptom** The `audit.verify` job failed and is in the dead-letter queue, or `preflight` refused
to start with "the audit log is not append-only". The audit log is write-once and each row is
chained to the one before it; this means a row was changed, removed or inserted out of order, or
that the application role regained the right to edit the table.

**Look at** `deploy/dc logs worker | grep "audit chain"`: each broken row is named by tenant,
position and id (never content), with `hash does not match the row content`, `gap` or
`prevHash does not follow the previous row`. The chain heads are logged daily as
`audit chain head`; compare with an earlier day in your backup log, since a head that moved
backwards means the table was replaced wholesale.

**Do** Treat it as a security incident, not a bug. Do not "fix" the rows: restore the table from
the last backup that verified (`docs/OPERATIONS.md#restoring`) into a scratch database and compare
before deciding what is true. If preflight named a privilege, a migration or a hand-run `GRANT`
restored it: re-run migrations (`deploy/upgrade.sh`), which revokes it and recreates the triggers.
Never disable the triggers to make a job pass.

**Fixed when** `audit_chain_verify()` returns no rows (`select * from audit_chain_verify();` as the
owner) and the next `audit.verify` run finishes without a warning.

### crypto.rekey

**Symptom** You are rotating `PLATFORM_ENCRYPTION_KEY` (a leak, a leaver, or hygiene), or the job
`crypto.rekey` is dead-lettered, or providers fail at call time with "not in the key ring".

**Look at** `GET /operator/crypto/status` as the operator: the key ring (active key first), and for
every encrypted column how many stored values each key id seals. `v1` is the old format, which is
read forever but never written; a key id that is not in the ring is a value nothing can open.
`pending` is what the job still has to move, and `previousKeysRemovable` is true when nothing needs
a previous key any more.

**Do** The drill, which you can rehearse on a staging copy of the database with
`packages/core/test/rekey.integration.test.ts` as the executable version:

1. Generate a new key: `openssl rand -base64 32`.
2. In `deploy/.env`: set `PLATFORM_ENCRYPTION_KEY` to the new key and `PLATFORM_ENCRYPTION_KEY_PREVIOUS`
   to the old one. `deploy/dc up -d api worker`. Check `/operator/crypto/status`: the ring lists both,
   `pending` counts what is under the old key, and the application works.
3. Start the re-encryption: `POST /operator/crypto/rekey` (or run the `crypto.rekey` job from the
   jobs page). It writes one row at a time with a compare-and-swap, so an admin saving a key
   during the run wins; it is safe to run twice, and it logs counts only.
4. When status reports `pending: 0` and `previousKeysRemovable: true`, remove
   `PLATFORM_ENCRYPTION_KEY_PREVIOUS`, restart, and check a provider test button once.
5. Keep the old key somewhere safe until the oldest backup that still needs it is past retention:
   a restore of an older backup needs the key that sealed it (set it as `..._PREVIOUS` for the
   restore, then run the job).

Email-address hashes (one response per person) cannot be re-keyed, because the address is not
stored. They are looked up under every key in the ring and rewritten under the active key when
the person returns. So do not remove the previous key while a campaign that dedupes respondents is
still open, or those people will be treated as new. If it is compromised and must go now, accept
that and say so to the campaign owners.

**Fixed when** `previousKeysRemovable` was true before the previous key was removed, status after
the restart shows one key in the ring, and no `crypto.rekey` dead letter remains.

### worker.heartbeat_stale

**Symptom** The worker has not confirmed that it can reach the job queue for five minutes. No jobs
are being processed: no summaries, no extraction, no emails, no analysis.

**Look at** `deploy/dc ps` (restarting? unhealthy?), `deploy/dc logs --tail 100 worker`. Postgres
being down or its connections exhausted is the usual cause.

**Do** If Postgres is the problem, fix that first (`deploy/dc logs postgres`). Otherwise
`deploy/dc restart worker`. The worker exits by itself after three missed checks so that Docker
restarts it; a worker that is _staying_ down is failing at start, and its log says why.

**Fixed when** The container is `healthy` and the heartbeat file is fresh.

### api.down

**Symptom** The API's readiness check has failed for five minutes. Participants and staff cannot use
the product (the web app answers, and every call behind it fails).

**Look at** `deploy/dc ps`, `deploy/dc logs --tail 100 api`, and
`curl -s http://localhost:4000/api/v1/health/ready` from inside the network:
`deploy/dc exec -T api node -e "fetch('http://127.0.0.1:4000/api/v1/health/ready').then(r=>r.text()).then(console.log)"`.
`database:false` means Postgres.

**Do** Postgres first if it is the cause; otherwise `deploy/dc restart api`. After a bad release,
[roll back](#upgrade-and-roll-back).

**Fixed when** The ready check returns `ok:true`.

### alerts.storm

**Symptom** The hourly ceiling (30 per audience by default) was reached and the rest were
suppressed. One notice is sent per hour; the alert it names as most frequent is the real problem.

**Look at** The kind named in the message. The suppressed alerts are all in the `OpsAlert` table:
`deploy/dc exec -T postgres psql -U app -d ai_discovery -c "select kind, count(*), max(\"lastAt\") from \"OpsAlert\" where kind <> '_rate' and \"lastAt\" > now() - interval '1 hour' group by 1 order by 2 desc"`.

**Do** Fix the source. If a flapping provider or a restart loop is the cause, its own runbook
section applies. Raising `ops.alertMaxPerHour` only makes the storm louder.

**Fixed when** The count of alerts per hour is back under the ceiling.

## Background jobs

Operator → **Background jobs** (`GET /operator/jobs`): every queue with what is waiting, what is
running, how many are dead-lettered, and its time limit and attempts.

- **Time limits.** Every job has its own `expireInSeconds` (`packages/core/src/jobs/definitions.ts`),
  its honest worst case, so a long `analysis.run` is no longer redelivered at fifteen minutes and run
  twice. A job past its limit is failed and retried by the queue.
- **Dead letters** stay for 30 days. Retry queues the job again with its payload and a fresh attempt
  budget, discard deletes it; both are audited (`job.retry`, `job.discard`) and clear the alert.
  The page shows identifiers and the last error, never the payload's text.
- **Run now** is offered for the jobs that take no payload: the retention sweep, the verification
  token prune and the health sweep.
- **The health sweep** runs every five minutes in the worker and raises or resolves the alerts that
  need looking: stuck jobs, dead letters the worker did not see (it was killed mid-job), the backup
  status, the disk and provider error rates.

## Backups

### What is taken, and where it goes

Every night at `BACKUP_AT` (03:20 UTC), and at each time in a comma list if you set one, the
`backup` container writes a **pair**, stamped identically:

| File                            | What                                                                   |
| ------------------------------- | ---------------------------------------------------------------------- |
| `ai_discovery-<stamp>.dump.age` | `pg_dump` (custom format), encrypted with `age` before it touches disk |
| `uploads-<stamp>.tar.gz.age`    | The uploads volume at the same moment (recordings, attached documents) |

It then decrypts the dump and reads its table of contents (a corrupt or unreadable one fails the
run), writes `/ops-state/status/backup.json` (when, how big, the table counts at that moment, the
offsite result), prunes local files older than `BACKUP_RETENTION_DAYS` (14), and, if
`RCLONE_REMOTE` is set, copies the pair offsite.

The container is **healthy only if the last backup succeeded and is recent**. A failed `pg_dump`
turns it `unhealthy` and raises [`backup.failed`](#backupfailed); no success for 26 hours raises
[`backup.missing`](#backupmissing).

### The key

Encryption uses an `age` key pair, created once and stored in `deploy/.env`:
`BACKUP_AGE_RECIPIENT` (public: encrypts) and `BACKUP_AGE_IDENTITY` (private: decrypts).
`generate-env.sh` creates it for a new install and `upgrade.sh` for an existing one.

**Lose the identity and every backup is noise.** `deploy/.env` is the file to copy to your password
manager the day you create it; it also holds `PLATFORM_ENCRYPTION_KEY`, without which a restored
database cannot decrypt provider keys. The key is never rotated by itself: replacing it would make
every earlier backup unreadable. To rotate, add a new key pair, take a backup, and keep the old
identity until the last backup written under it has aged out.

### Offsite

Set `RCLONE_REMOTE` and the credentials in `deploy/.env` (the commented block `generate-env.sh`
wrote). Example for an S3-compatible bucket (Hetzner Object Storage, Scaleway):

```bash
RCLONE_REMOTE=offsite:my-aidp-backups
RCLONE_CONFIG_OFFSITE_TYPE=s3
RCLONE_CONFIG_OFFSITE_PROVIDER=Other
RCLONE_CONFIG_OFFSITE_ENDPOINT=https://fsn1.your-objectstorage.com
RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID=...
RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY=...
```

Backblaze B2: `RCLONE_CONFIG_OFFSITE_TYPE=b2`, `RCLONE_CONFIG_OFFSITE_ACCOUNT`,
`RCLONE_CONFIG_OFFSITE_KEY`. Then `deploy/dc up -d backup` and
`deploy/dc exec -T backup /usr/local/bin/backup.sh once`; `status.offsite` should read `ok`.

The files are already ciphertext, so the bucket holds nothing readable and needs no special access
policy beyond not being public. The remote keeps 30 daily, 13 weekly (Sundays) and about 13
monthly (the 1st) copies, pruned on every run. **With `RCLONE_REMOTE` unset there is no copy off
this host**, and `status.offsite` says `not_configured`; a dead host, a deleted VPS or a
ransomwared disk takes the backups with it. That is a risk you may accept, but it should be one you
chose.

### Retention

| What                  | Kept                                                                 |
| --------------------- | -------------------------------------------------------------------- |
| Local dumps and files | `BACKUP_RETENTION_DAYS` days (14)                                    |
| Offsite               | 30 daily, 13 weekly, 13 monthly                                      |
| Container logs        | 3 files of 10 MB per container                                       |
| Dead letters          | 30 days                                                              |
| The `models` volume   | Not backed up: a cache of a pinned model id, re-downloaded on demand |

The models volume is a decision (D-95): it holds the on-server Whisper model, about 250 MB fetched
from Hugging Face on first use in a minute or two. The ledger, routes and transcripts are in
Postgres. After a restore on a host with no route to Hugging Face, recordings answer "try again in
a minute" until the download succeeds; route `transcription` to OpenAI if that matters on the day.

### What you can expect, and have not yet measured

| Target                                               | Value                      | How                                                                        |
| ---------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------- |
| Data you can lose (RPO)                              | 24 h (12 h with two times) | `BACKUP_AT=03:20,15:20`                                                    |
| Back in service after a bad release, same host (RTO) | 15 min                     | [`rollback.sh`](#upgrade-and-roll-back), then `restore.sh` if data changed |
| Back in service after losing the host (RTO)          | 90 min                     | new VPS, `git clone`, `deploy/.env` from your password manager, restore    |
| Verified                                             | **not yet automatic**      | restore a backup into a scratch database yourself, below                   |

The weekly automatic restore drill with a row-count assertion is the next milestone; until it
exists the only proof a backup restores is that you restored one.

## Restoring

```bash
deploy/restore.sh                                       # list what is in the backups volume
deploy/restore.sh --latest --into ai_discovery_check    # verify the newest, live data untouched
deploy/restore.sh --latest --force                      # disaster: over the live database
```

It reads the dump and decrypts it **before** it stops anything or drops anything, so a missing key
or a damaged file leaves the live database exactly as it was. A live restore stops `api` and
`worker`, recreates the database, restores the dump and the matching uploads archive, and starts
them again; `migrate`, `db-grants` and `preflight` run on the way up, so an older dump is migrated
forward and re-checked.

After `--into ai_discovery_check`, compare against the manifest:

```bash
deploy/dc exec -T backup jq .counts /ops-state/status/backup.json
deploy/dc exec -T postgres psql -U app -d ai_discovery_check -tAc 'select count(*) from "Session"'
deploy/dc exec -T postgres psql -U app -d postgres -c 'drop database ai_discovery_check'
```

**Onto a new host** (the host is gone): install Docker, clone the repository, put your saved
`deploy/.env` in `deploy/`, `deploy/upgrade.sh` (starts an empty stack, which is fine), then bring
the files back and restore:

```bash
# the remote is the RCLONE_REMOTE value in deploy/.env; copy the newest pair (or all of daily/)
deploy/dc run --rm --no-deps --entrypoint rclone backup copy offsite:my-aidp-backups/daily /backups
deploy/restore.sh --latest --force
```

DNS last, once the sign-in page works.

## Upgrade and roll back

```bash
git pull
deploy/upgrade.sh              # the first deployment is the same command
deploy/upgrade.sh --dry-run    # say what it would do
deploy/rollback.sh             # back to the previous version, no rebuild, no network
```

`upgrade.sh`, in order, and what each step is for:

1. **Refuses** if this host has `deploy_pgdata` volumes from before the project was named and
   `COMPOSE_PROJECT_NAME` does not match: the switch would start on an empty database. An install
   made before the name was pinned puts `COMPOSE_PROJECT_NAME=deploy` in `deploy/.env`.
2. **Takes a backup** through the running backup container and stops if it fails. The dump it names
   is the data-side rollback.
3. **Builds** the images tagged with the git SHA (`aidp-server:<sha>`, `aidp-web`, `aidp-backup`,
   `aidp-ops-notify`). The previous generation stays on the host. A working tree with uncommitted
   changes is refused unless `--allow-dirty`, and then it is tagged `<sha>-dirty-<time>`, never the
   plain sha.
4. **Makes sure the backup key exists** (once).
5. **Switches** behind the maintenance page: `migrate` (as the owner role), `db-grants`,
   `preflight`, then `api`, `worker`, `web`. Participants see "back in a minute" with a
   `Retry-After`, in English and Finnish, and not a proxy error.
6. **Checks**: every service healthy, the API ready with a live database, the web app up, and the
   sign-in page served through Caddy. If a check fails it rolls the code back by itself and says
   what the schema is now.
7. Takes the maintenance page down and keeps the last three image generations.

`deploy/versions.env` records `AIDP_VERSION`, `AIDP_PREVIOUS_VERSION` and the pre-upgrade dump. It is
written by these scripts and never by hand. The first upgrade from an install that used
`:latest` images has no previous version recorded, so it has no rebuild-free rollback: its way back
is `git checkout` of the earlier commit and `upgrade.sh`, plus the pre-upgrade dump for data.

`rollback.sh` switches the tag and recreates the containers; it does not undo migrations. See below
for what that means.

### migrate.failed

**Symptom** `upgrade.sh` stopped with "the switch failed before the application was replaced".
`deploy/dc ps -a` shows `migrate` exited non-zero, or `preflight` did. Nothing was replaced: the
previous version is still running and `versions.env` still names it. Prisma applies each migration
in its own transaction, so the database is at a migration boundary, not half-way through one.

**Look at** `deploy/dc logs migrate` for the error and the migration's name.

**Do** One of three, by what the log says:

1. **Transient** (Postgres was restarting, a lock timeout): run `upgrade.sh` again. Prisma resumes
   at the failed migration.
2. **The migration is wrong**: fix it in a new commit; before re-running, mark the failed one
   rolled back (`deploy/dc run --rm migrate sh -c "pnpm --filter @aidp/db exec prisma migrate resolve --rolled-back <name>"`),
   undoing any partial DDL by hand if the migration was not transactional; then `upgrade.sh`.
3. **The old code cannot live with what was applied**: `deploy/rollback.sh`, then
   `deploy/restore.sh <the dump upgrade.sh printed> --force` to put the data back.

**Fixed when** `deploy/dc ps` shows `migrate` exited 0 and every service healthy, on the version you
meant.

### Why most upgrades need no data rollback

Migrations here only add (a nullable column, a table, an index); a drop or rename ships one release
after the code stopped reading the old shape. That is what lets the previous code run against the
newer schema, so rolling back is a tag switch. A migration that does not follow this says so in its
header, and that release needs the dump.

## Provider timeouts and retries

Every model call has a deadline (`packages/ai/src/providers/resilience.ts`). Defaults, in
`deploy/.env` as milliseconds if a slow self-hosted gateway needs more:

| Variable                          | Default | Meaning                                              |
| --------------------------------- | ------- | ---------------------------------------------------- |
| `PROVIDER_TIMEOUT_MS`             | 120000  | The ceiling for one call, streaming included         |
| `PROVIDER_FIRST_TOKEN_TIMEOUT_MS` | 20000   | A stream that has produced nothing by then is failed |
| `PROVIDER_IDLE_TIMEOUT_MS`        | 30000   | The longest silence once output has started          |
| `PROVIDER_MAX_RETRIES`            | 2       | Extra attempts on a network error, 429 or 5xx        |

A timeout is reported to the participant as "temporarily unavailable, your answer is saved" and is
not retried inside the same request (that would turn two minutes into six). Realtime voice sockets
are not covered by these yet.

## What lives outside the box

Two things, and the repository cannot hold either:

1. **`deploy/.env`.** It holds the database passwords, `PLATFORM_ENCRYPTION_KEY` and the backup
   identity: the keys to the data, the stored provider keys and the backups. Copy it to your
   password manager when it is created and whenever it changes.
2. **The offsite bucket's credentials**, which are in `deploy/.env` too, and the bucket itself.

Everything else (compose, scripts, the alert catalog, the checks, this document) is in the repository
and is what a new host is built from.

## Not yet

Planned in the operations program and not built, so that nothing here is read as a promise:
worker tracing and request/session ids in log lines, p95 first-token and voice metrics, dashboards,
a weekly automatic restore drill with row-count assertion, per-tenant spend statements, circuit
breaker and fallback route, load and chaos tests, and the recorded owner drills.
