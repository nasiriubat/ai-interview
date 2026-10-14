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
| Daily               | Operator → **Platform health**: nothing red. `deploy/dc ps`: nothing `unhealthy` or restarting. Operator → Background jobs: dead letters at 0.          | 1 minute |
| Weekly              | Platform health → Restore drill: `Restored and matched`, within the last nine days. `offsite` is `ok` (or you have accepted that it is not configured). | 1 minute |
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
platform's own SMTP relay (`SMTP_HOST` and its siblings), so a mail alert needs that relay to work: this is why
a webhook is worth having as well.

Once the application is running, **Admin → Settings → Operations alerts** (platform scope) takes
over from the environment and adds the dials: minimum severity per channel, how long before an
unresolved alert is sent again, the hourly ceiling, and the disk, provider and backup thresholds.
`deploy/.env` stays as the fallback and as what the sidecar reads.

### What a tenant is sent

Budget notices (at 80 and 90 percent of a budget, and when it is used up), three notices about
the tenant's own work (a campaign reached its completion threshold, an analysis is ready, a
specification version was generated), and the ceiling notices (a limit the operator set is at 80
percent or reached), and the notice that an interview was flagged for hostility or distress
(`session.flagged`, ids only). They go to that tenant's own admins, or the list in `notifications.recipients`,
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

### session.flagged

**Symptom** The interviewer flagged an interview for hostility or distress. Sent only to the
tenant's own admins (or `notifications.recipients`), never to the operator and never with what was
said: the notice carries a session id and a campaign id. The interview itself carries on gently.

**Look at** The campaign's interviews list, filtered on flagged (Admin, Campaigns, the campaign,
Interviews). The reason is on the interview page and is shown only to someone who may read
transcripts (`privacy.rawTranscriptsVisibleTo`).

**Do** Nothing on the platform side. The tenant's admin reads it, decides whether anyone needs a
call, and presses Acknowledge, which is audited (`session.flag.ack`). If a tenant says they never
got one, check that the address is an admin of that tenant or listed in `notifications.recipients`.

**Fixed when** An admin acknowledges the interview. The notice repeats at most once a day per
interview.

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

**After a crash, not a hang.** A worker killed outright (the OOM killer, a host reboot, `kill -9`)
leaves the jobs it was running `active` on the queue; nothing in the process can say so, and the
queue's own expiry fails them only when their time limit passes: `analysis.run` is an hour,
`spec.generate` half an hour, `session.extract` three minutes. The worker therefore keeps a lease
(refreshed every 15 s) and records which job it is running (tables `pgboss.aidp_worker_lease` and
`pgboss.aidp_job_claim`, D-281). At start and every 15 s, each worker fails the `active` jobs that
are claimed by a worker whose lease has not been refreshed for 45 s; the queue then retries them
with its usual backoff, or dead-letters them when their attempts are spent. The restarted worker
takes over its predecessor's job about a minute after the kill (rehearsed by
`deploy/chaos/kill-worker.mjs`). It is safe with several workers: a job held by a live worker, or
with no claim at all, is never touched, and the claim is removed before the job is failed, so two
workers cannot both fail it. The handlers are idempotent, which is what makes a retry safe.

Nothing to do by hand in that case. If a job is still `active` past its limit **and the worker has
been healthy for a few minutes** (the recovery tables could not be created, which the worker logs as
"job recovery disabled"), tell the queue the limit has passed:

```bash
deploy/dc exec -T postgres psql -U app -d ai_discovery -c \
  "update pgboss.job set started_on = now() - interval '2 hours' where state = 'active' and name = 'analysis.run'"
```

The queue's maintenance (every minute) fails the job and the retry policy runs it again; it
completes once, with one result. Do this only when the worker has really been restarted: an
`active` job on a worker that is still alive is working.

**Fixed when** The active count drops and the next sweep resolves the alert (within five minutes).
Check for a dead letter afterwards.

### backup.failed

**Symptom** The last backup run failed: `pg_dump` returned non-zero, the archive did not read back,
or the uploads archive could not be written. The backup container is `unhealthy`.

**Look at** `deploy/dc logs --tail 50 backup`, and the reason in
`deploy/dc exec -T backup cat /ops-state/status/backup.json`. Disk space (`df -h`, the
[`disk.high`](#diskhigh) alert) and Postgres health are the usual causes. One more, since the
backup stopped running as root (D-312): `Permission denied` on `/backups` or an unreadable upload
means the volume's ownership was not set. `deploy/dc up -d` runs `ops-state-init`, which sets it
(`/backups` to uid 999, the alert and watchdog directories to 10001); the container must show
`groups=...,1000` in `deploy/dc exec -T backup id`, which the `group_add` in `compose.prod.yml`
gives it.

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

### backup.drill_failed

**Symptom** The weekly restore drill could not restore the newest backup, or what it restored did
not match the manifest written with the dump (fewer rows than the dump began with, or an uploads
archive with a different number of files). The backup container is `unhealthy`. This is the one
alert that says a backup exists and may not be usable.

**Look at** The reason is in the alert and in
`deploy/dc exec -T backup cat /ops-state/status/backup.json` under `drill.error`. Then
`deploy/dc logs --tail 80 backup | grep restore-drill`. Typical causes: the identity in `deploy/.env`
is not the key the dump was written to (`BACKUP_AGE_IDENTITY`), the disk filled mid-restore, or a
dump written by a version whose migration is not applied.

**Do** Run it by hand and read the output: `deploy/dc exec -T backup /usr/local/bin/restore-drill.sh`.
If the dump itself is bad, take a fresh one (`backup.sh once`) and run the drill again. Do not treat
the previous backups as good until a drill has passed against one of them.

**Fixed when** `restore-drill.sh` exits 0, `drill.result` is `ok`, and the container is `healthy`.

### disk.high

**Symptom** The disk holding the database, the uploads and the backups is above 80 percent
(warning) or 90 (critical). At 100 Postgres stops accepting writes and the API returns 500s while
every container still looks fine. An upload that does not fit is answered `507 storage_full`, which
the participant sees as "the service cannot store files right now" (en and fi) with their answers
kept; the interview carries on in writing. This alert is how you learn of it.

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

### provider.fallback_active

**Symptom** A purpose is being served by its fallback route because the primary provider is failing
and its circuit is open (five timeouts, 5xx or 429 inside a minute). Interviews continue, on the
model you named as the fallback, and each such call is a ledger row with `routeTier = fallback`. If
no fallback is configured the alert is [`provider.error_rate`](#providererror_rate) instead and calls
fail fast with "temporarily unavailable".

**Look at** Operator → Platform health → Providers (the circuit column). The provider's status page.
`deploy/dc logs --since 15m api | grep provider`. The fallback's own quality and price: it is
usually a different model, and every call on it is billed at its price.

**Do** Nothing is required for the interviews. Fix or wait out the primary; the circuit lets one
probe call through every thirty seconds and closes by itself when it succeeds. If the outage is
long, check the fallback's budget line and that its answers are acceptable.

**Fixed when** The circuit is closed (Platform health shows it) and the alert resolves with it.

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

**What a participant sees when the API process is killed mid-turn** (rehearsed with `kill -9` on
2026-10-14, `deploy/chaos/kill-api.mjs`): the stream ends, their answer is already saved (one copy),
Docker restarts the API in seconds, and the session is intact. The turn lock belongs to a process
that no longer exists and is released by its TTL, 10 s (it is renewed every 2 s while a turn runs,
D-282); until then every retry is refused with `conflict` (82 s in the rehearsal, with the earlier
90 s TTL). Nothing to do; it is the cost of not releasing a lock on a guess. A graceful stop (`deploy/dc restart api`, an upgrade) drains turns first and releases them.

### abuse.limit_hit

**Symptom** An interview link refused new interviews or verification codes because it reached an
abuse limit. The message names the limit: `campaign_hour` (`abuse.campaignSessionsPerHour`),
`campaign_total` (`abuse.campaignSessionsTotal`), `tenant_hour` (`abuse.tenantSessionsPerHour`) or
`address_emails` (`abuse.distinctEmailsPerAddressPerHour`, one internet address asking codes for
many different email addresses). Participants over the limit see "busy, try again later" (429);
the email-code endpoints keep answering "ok" and send nothing, so an attacker learns nothing. The
tenant's admins and you are told, once an hour per campaign and limit.

**Look at** Is it real demand or an attack? A campaign that invited 3000 people and hit
`campaign_total` is demand; a link posted somewhere public and `campaign_hour` hit at 03:00 is not.
`deploy/dc exec -T postgres psql -U app -d ai_discovery -c "select \"key\", \"count\", \"windowStart\" from \"UsageCounter\" where \"windowStart\" > now() - interval '3 hours' order by \"count\" desc limit 20"`
(the keys name campaigns and keyed address hashes, never addresses). The API log lines
`abuse signal` carry the campaign id and the limit. Interviews already created are not removed.

The defaults (D-311) are 300 new interviews an hour per campaign, 1000 an hour per organization and
2000 per campaign in all; the per-address bucket on the link routes (`RATE_LIMIT_PUBLIC_MAX`, 120 a
minute) is separate, answers a plain 429 and raises no alert. A second drill showed what 120 an
hour did to a launch concentrated on one campaign: 311 of 499 open attempts refused inside five minutes (retries counted).

**Do** Demand: raise the limit (Settings, category Privacy, at the campaign or tenant scope).
Attack: close the campaign (`Admin → Campaigns → Close`) and issue a new link or switch it to
`email_code` verification with an allowed domain; if one address is the source, block it at the host
firewall (`ufw deny from <address>`). Check the model spend of the tenant
(`Admin → Budgets`): the tenant ceiling `ceiling.maxSessionsPerMonth` is the last fence.

**Fixed when** The hourly windows pass, or the limit is raised; the next hit is a new alert.

### alerts.storm

**Symptom** The hourly ceiling (30 per audience by default) was reached and the rest were
suppressed. One notice is sent per hour; the alert it names as most frequent is the real problem.

**Look at** The kind named in the message. The suppressed alerts are all in the `OpsAlert` table:
`deploy/dc exec -T postgres psql -U app -d ai_discovery -c "select kind, count(*), max(\"lastAt\") from \"OpsAlert\" where kind <> '_rate' and \"lastAt\" > now() - interval '1 hour' group by 1 order by 2 desc"`.

**Do** Fix the source. If a flapping provider or a restart loop is the cause, its own runbook
section applies. Raising `ops.alertMaxPerHour` only makes the storm louder.

**Fixed when** The count of alerts per hour is back under the ceiling.

### tenant.offboarded

**Symptom** A tenant's data was removed: its rows and its stored bytes, its audit trail, and the
export that was taken before. Informational: it is the confirmation that an offboarding finished,
with the counts, and it is sent once.

**Look at** The alert's counts, and `deploy/dc exec -T worker cat /ops-state/erasures.jsonl | tail`
for the entry that records the erasure.

**Do** Nothing, unless you did not expect it: the request is in the audit log of your own company
as `tenant.offboard_requested`, with who asked. It cannot be undone; a restore of an older backup
finds the entry in `erasures.jsonl` and removes the tenant again at the worker's next start.

**Fixed when** There is nothing to fix. A purge that left rows behind does not send this alert: it
fails and is retried, and shows as a dead letter in `tenant.offboard`.

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
  token prune, the health sweep, the audit verification and the monthly statement.
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

### The weekly restore drill

Every Sunday at 04:40 UTC (`BACKUP_DRILL_DAY`, `BACKUP_DRILL_AT`; `BACKUP_DRILL=off` disables it)
the backup container restores the newest dump into a scratch database, `ai_discovery_drill`, and
compares it with the manifest that was written beside the dump:

| Check                                                                             | Rule                                                                                                                 |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| The dump decrypts and `pg_restore` completes                                      | any error fails the drill                                                                                            |
| Row counts (Company, User, Campaign, Session, Message, Fact, Attachment, LlmCall) | each at least what the dump began with; the counts are taken just before the dump, so writes in between can only add |
| The uploads archive of the same stamp                                             | decrypts, and lists exactly as many files as the manifest counted (counted from the archive itself)                  |

The scratch database is always dropped, and the live database and the live uploads are never
touched. The result is in `backup.json` under `drill` (`result`, `at`, `durationS`, `lastSuccessAt`,
`error`); a failure raises [`backup.drill_failed`](#backupdrill_failed) and turns the container
unhealthy. `durationS` is how long a restore of this size takes on this host, which is the figure
the RTO below is measured against. The drill proves the dump restores and matches; it does not prove
the application is happy with it (that is a manual restore into the stack, below).

Run it by hand any time: `deploy/dc exec -T backup /usr/local/bin/restore-drill.sh`.

### RPO and RTO

| Target                                               | Value                      | How                                                                        | Evidence                               |
| ---------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------- | -------------------------------------- |
| Data you can lose (RPO)                              | 24 h (12 h with two times) | `BACKUP_AT=03:20,15:20`                                                    | `backup.json` `lastSuccessAt`          |
| Back in service after a bad release, same host (RTO) | 15 min                     | [`rollback.sh`](#upgrade-and-roll-back), then `restore.sh` if data changed | `drill.durationS` plus a rollback run  |
| Back in service after losing the host (RTO)          | 90 min                     | new VPS, `git clone`, `deploy/.env` from your password manager, restore    | the table below, from the offsite copy |
| Verified                                             | weekly, automatic          | the restore drill above                                                    | `drill.lastSuccessAt`                  |

**What a person has to prove, and the repository cannot.** The drill runs on the host the backups
are on. It does not show that you can rebuild from the offsite copy on a machine that is not that
host, with only `deploy/.env` from your password manager, inside ninety minutes. Do that once before
the pilot and again after any change to the backup or the key, and write down what happened in
`docs/team/drills/<date>-restore.md`. One row per rehearsal:

| Date | Version | From (local / offsite) | Dump size | Fetch | Decrypt and restore | Stack up | Sign-in works | Total | RTO target  | Surprises, and what changed in the repository |
| ---- | ------- | ---------------------- | --------- | ----- | ------------------- | -------- | ------------- | ----- | ----------- | --------------------------------------------- |
|      |         |                        |           |       |                     |          |               |       | 15 / 90 min |                                               |

The same file records the **automatic** evidence next to it, so the two can be read together:

| Week of | `drill.result` | `drill.durationS` | Rows restored (Session / Message / LlmCall) | Manifest matched |
| ------- | -------------- | ----------------- | ------------------------------------------- | ---------------- |
|         |                |                   |                                             |                  |

An RTO that has never been measured is a guess. The first line of each table is the first thing to
fill in on a real host.

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
5. **Migrates first, on its own**, behind the maintenance page: `migrate` (as the owner role),
   `db-grants` and `preflight` run one after the other through `docker compose run`, which touches no
   other container. If any of them fails nothing has been replaced: the previous `api`, `worker`
   and `web` are still serving, the page comes down again and the script stops (see
   [migrate.failed](#migratefailed)). Participants saw "back in a minute", for about five seconds,
   and not an error. (Until 2026-10-14 these ran as part of one `up -d`, which on a failed
   migration had already re-created `api`, `web` and `worker` under the new tag and not started
   them: Caddy answered 502 while the message said the previous version was running.)
6. **Switches** `api`, `worker` and `web` to the new tag, still behind the page. Participants see
   "back in a minute" with a `Retry-After`, in English and Finnish, and not a proxy error.
7. **Checks**: every service healthy, then the page comes down and the API ready check, the web app
   and the sign-in page through Caddy are made. (Caddy answers 503 while the page is up, so the
   check cannot be made before it comes down; if it fails the page goes back up before the rollback.)
   If a check fails it rolls the code back by itself and says what the schema is now.
8. Keeps the last three image generations.

`deploy/versions.env` records `AIDP_VERSION`, `AIDP_PREVIOUS_VERSION` and the pre-upgrade dump. It is
written by these scripts and never by hand. The first upgrade from an install that used
`:latest` images has no previous version recorded, so it has no rebuild-free rollback: its way back
is `git checkout` of the earlier commit and `upgrade.sh`, plus the pre-upgrade dump for data.

`rollback.sh` switches the tag and recreates the containers; it does not undo migrations. See below
for what that means.

### migrate.failed

**Symptom** `upgrade.sh` stopped with "migrate failed; nothing was replaced and the previous
version is still running" (or `db-grants`, or `preflight`). Nothing was replaced: the previous
version is still running, participants saw the maintenance page for a few seconds and then the site
again, and `versions.env` still names the old version. Prisma applies each migration in its own
transaction, so the database is at a migration boundary, not half-way through one; the failed
migration is recorded as failed in `_prisma_migrations`, and `prisma migrate deploy` will refuse to
go on until it is resolved (option 2 below). Rehearsed with a deliberately failing migration on
2026-10-14: about five seconds of maintenance page, then 200s, the old containers never touched.

**Look at** The error and the migration's name, printed by the script above its warning. The
one-shot ran with `--rm`, so it is not in `deploy/dc logs`; run it again to see it:
`deploy/dc run --rm -T migrate`.

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
newer schema, so rolling back is a tag switch. A migration that does not follow this carries a
`-- migration-policy: allow-destructive <reason>` line, and that release needs the dump. The policy
and the gate that enforces it (`scripts/check-migrations.mjs`, in `pnpm check`) are in
[`MIGRATIONS.md`](MIGRATIONS.md).

## Locked out / email not working

Symptom: the sign-in page ends on "the sign-in email could not be sent" (`/auth/error`, Auth.js
`EmailSignin`), or the link never arrives, and nobody who could fix the relay is signed in.

1. **Get one person in.** On the server:

   ```bash
   deploy/signin-link.sh admin@example.com      # or the operator's address
   ```

   It prints a one-time sign-in URL, valid for 15 minutes, for an existing, enabled staff user of an
   active organization (the operator is never refused for their organization). Open it in the
   browser that should be signed in. Exit status 1 means refused, and the reason is on stderr: an
   unknown address, a disabled user (another admin or the operator re-enables them), or a suspended
   organization (the operator reactivates it, or signs in as the operator instead). Each issued link
   is an audit row `auth.signin_link_issued`, actor `cli`, and a warning line; the token is in
   neither. [DEPLOY.md](DEPLOY.md#break-glass-a-sign-in-link-from-the-servers-shell) says why this
   adds no privilege.

2. **Find out what the relay says.** `./deploy/dc logs web --since 1h | grep -i -E 'smtp|mail'`
   shows the transport error (the web app sends sign-in links). Typical causes: a wrong password or
   user name, a password with `@`, `:` or `/` that is not percent-encoded, `smtp://` on port 465
   (that port wants `smtps://`), an outbound port blocked by the hosting provider (many block 25 and
   some 587; try 465 or 2525), or a sender address the relay is not allowed to send for.
3. **Fix `EMAIL_SMTP_URL`** (and `EMAIL_FROM`) in `deploy/.env`, then `./deploy/dc up -d` so the api,
   worker and web pick it up. Any SMTP relay works: a transactional email provider, the SMTP
   submission service of your organization's mailbox provider, or your own mail server. Publish SPF
   and DKIM for the sender's domain as that relay documents, or links land in spam.
4. **Prove it.** Settings, Email, "Send test email" sends to your own address and names the class of
   failure. Then sign out and sign in by email once, the way everyone else will.

The break-glass link is not a substitute for mail: invitations, reports, alerts and every other
person's sign-in still need the relay. If links are being issued routinely, the relay is the
problem to fix. To see who used it: Audit log, filtered by the action `auth.signin_link_issued`.

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

## Looking at the platform

Three levels, from the cheapest to read.

1. **Operator → Platform health** (`GET /operator/health`). One page: every signal as a traffic
   light (queue depth and age, dead letters, stuck jobs, worker heartbeat, backup age, offsite copy,
   restore drill, disk, provider error rates and circuits, first-token and voice-first-word p95
   against their targets, the speech model, open alerts), the release that is running, and a row
   per tenant with its interviews this month, active now, spend against its budget, storage and
   voice minutes against their ceilings, open campaigns and dead letters. It reads the same inputs
   the five-minute sweep does; it raises nothing itself.
2. **`GET /stats`** (and the tenant dashboard): `ai.month.firstTokenP50Ms` and `firstTokenP95Ms`
   (interview and specification turns, from `LlmCall.firstTokenMs`), `audioMinutes`,
   `ttsCharacters`, the estimated share of the cost, and the live-voice signals. `GET /spend` groups
   by `provider` and `status` as well as day, purpose, model and campaign; `GET /spend/budgets`
   shows spend against each budget line.
3. **Grafana**, optional (`infra/observability`, [README](../infra/observability/README.md)):
   Prometheus and Grafana with six dashboards and the objectives drawn on them. It needs 416 MB more
   than the stack; Tempo for traces needs another 192 MB and belongs on the 8 GB preset.

**Objectives.**

| Objective             | Target                             | Where it is read                                                                                  |
| --------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------- |
| First token (NFR-01)  | p95 under 2.0 s                    | Platform health, `/stats`, Grafana "Overview and SLOs"                                            |
| Voice first word      | p95 under 1.5 s                    | Platform health, Grafana "Live voice"                                                             |
| Model call error rate | under 5 %                          | Platform health, Grafana                                                                          |
| Queue age             | oldest queued job under 5 minutes  | Platform health, Grafana                                                                          |
| Job success           | at or above 99.5 % over 7 days     | Grafana "Background jobs"                                                                         |
| Backup                | newest under 26 h, drill under 9 d | Platform health, [`backup.missing`](#backupmissing), [`backup.drill_failed`](#backupdrill_failed) |

**Tracing.** Set `OTEL_EXPORTER_OTLP_ENDPOINT` (in `deploy/.env`) and both `api` and `worker` export
spans. A request is one trace: `session.turn` with its `model.call` children in the API, and the
`job <name>` spans of the follow-up jobs it queued in the worker, joined by the `traceparent` carried
in each job's payload. With no endpoint nothing is loaded and nothing is paid for.

## What is never logged

At every level and in every environment except `NODE_ENV=development`, one shared definition
(`packages/core/src/telemetry/redaction.ts`) applies to the API and the worker:

| Never in a log line                                                                  | What is there instead                                                      |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Participant link and invitation tokens in URLs                                       | `/p/<token>`, `/p/r/<token>`; every query string becomes `?<redacted>`     |
| What a person said: message text, transcripts, summaries, facts, extracted file text | `[redacted]`; handlers log ids and counts                                  |
| Email addresses                                                                      | `<email:1a2b3c4d>`, a short hash, so two lines about one address correlate |
| API keys, passwords, SMTP URLs, provider headers                                     | `[redacted]`                                                               |
| Upload filenames                                                                     | the extension only                                                         |

Every line written inside a request or a job carries `tenantId`, and `sessionId`, `userId`, `jobId`
and `traceId` where they exist, so `grep tenantId=...` follows one tenant. Caddy's access log is
filtered the same way (`deploy/Caddyfile`): link tokens in the path are rewritten and the keys that
carry a secret are removed from the query. The audit log and the ledger are not logs: they are
data, under row-level security. `packages/core/test/telemetry.test.ts` and the Caddyfile check in
`deploy-scripts.test.ts` fail when a category leaks.

## Cost statements

Every month the `billing.statement` job (02:17 UTC on the 1st, or Run now on the jobs page) freezes
each tenant's previous month into a `TenantStatement` row: one line per provider, model and purpose
with calls, the four token counts, audio seconds, TTS characters, cost and the estimated part of it,
plus sessions started and completed, participants, voice minutes, storage, analyses and
specifications, and each budget line with whether it was hit. It is frozen on purpose: the ledger
rows under it are subject to retention, and an invoice must not change when they are purged.

- **Tenant**: `GET /spend/statements`, `GET /spend/statements/<yyyy-mm>?format=csv`.
- **You, across tenants**: `GET /operator/statements/<yyyy-mm>?format=csv`, one file with the
  company on every line, which is what an invoicing spreadsheet wants.
- **Redo a month** (after fixing a price): the job takes `{ "month": "2026-09", "force": true }`,
  and without `force` leaves an existing statement as it is. Run now produces the month that just
  ended; no route queues it with a payload yet, so an older month or a forced redo is a `pg-boss`
  `send` by hand until one does.
- **Estimated** cost is usage this system computed because the provider reported none (an abandoned
  stream, a call that died). It is in the totals and shown separately; it is never the bulk of a
  month, and if it is, a provider is not reporting usage and the price table is the thing to look at.

Prices for audio and speech are set per model in Admin → Providers (`audioPerMinute`,
`ttsPerMChars`, in USD); the OpenAI audio models are seeded. A model with no audio price books its
seconds and costs nothing, which shows as audio seconds with zero cost in the statement.

## Provider outages

Each provider has a circuit breaker per process (`packages/ai/src/providers/breaker.ts`). Five
timeouts, network errors, 5xx or 429 in a minute open it; for thirty seconds calls to that provider
are not made; then one probe is let through, and its outcome closes or re-opens the circuit. A bad
request or a refusal never counts. What a call does meanwhile:

- **With a fallback route** for the purpose (`PUT /routes` or `PUT /operator/routes` with a
  `fallback: { providerId, model }` on the row; `GET /routes` returns it, `null` when none; a picker
  on the Routing page is not built yet): the call goes to the fallback, in the same request, before the
  participant sees anything. Both attempts are ledgered, the second with `routeTier = fallback`, and
  [`provider.fallback_active`](#providerfallback_active) is raised once per provider.
- **Without one**: the call fails at once with "temporarily unavailable, your answer is saved", and
  [`provider.error_rate`](#providererror_rate) is raised, instead of every participant waiting out
  a timeout.

Choose the fallback on a different provider (the route refuses the same one) and check its price:
the budget is spent at the fallback's price while it is in use.

## Resource ceilings

Each tenant has four operator-set ceilings (`ceiling.*`; 0 means none): campaigns at once,
interviews per month, stored bytes, voice minutes per month. All four refuse where the thing is
created, with `403 limit_reached` and the limit named, and tell the tenant at 80 and at 100 percent
and the operator at 100 ([`ceiling.warning`](#ceilingwarning), [`ceiling.reached`](#ceilingreached)):

| Ceiling               | Where it is enforced                                                                               | What the participant sees                              |
| --------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `storageBytes`        | at the upload: refused when full, and the upload is capped to what is left and re-checked after it | the attachment is refused; the interview continues     |
| `voiceMinutes`        | at the recorded answer; at the live call before its socket opens, and every minute of the call     | recorded: a refusal; live: "unavailable, type instead" |
| `maxSessionsPerMonth` | when an interview starts                                                                           | the link says the organization is at its limit         |
| `maxActiveCampaigns`  | when a campaign is created or opened                                                               | (admin) the campaign is refused                        |

Voice minutes are the larger of the recordings' durations and the audio seconds in the ledger (live
calls and recorded answers are both transcribed, so they are never added together).

## Tenant export and offboarding

Both are the operator's, API only for now (there is no button on the tenants page yet), and both are
in your own company's audit log, not the tenant's: offboarding removes the tenant's audit trail, and "who took a copy of this tenant's
data and who removed it" has to outlive it.

**Export** (`POST /operator/tenants/<id>/export`, then `GET .../exports` and `GET .../exports/<stamp>`).
A zip with a JSON-lines file per table (every table with the tenant's `companyId`, found from the
database), its uploads, a manifest with a SHA-256 for each entry, and a signature of the manifest.
Sealed secrets and token hashes are left out. At rest it is ciphertext (the platform key), so a
backup of the uploads volume holds nothing readable; the download route decrypts it, and refuses
if a segment does not authenticate.

**Offboarding** (`POST /operator/tenants/<id>/offboard {"confirmName": "<the tenant's name>"}`).

1. Suspend the tenant first (Operator → Tenants → Suspend). Staff, participants and jobs stop.
2. Send the request. It takes an export now and queues the purge for seven days from now;
   `"immediate": true` queues it at once. **Reactivating the tenant during the seven days cancels
   it**: the job checks it is still suspended before it removes anything.
3. Give the tenant its export (download it, hand it over by whatever channel you agreed).
4. The purge removes the tenant's queued jobs, its files and its exports, its rows (children before
   parents), and its audit rows; then checks that no table that carries its id still holds a row.
   A purge that finds one fails and is retried; it does not report success.
5. What remains: the `Company` row as `Deleted tenant` (statements and the ledger refer to its id),
   its `TenantStatement` rows (accounting), and the erasure entry.

**Restoring after an offboarding.** The erasure is recorded in `/ops-state/erasures.jsonl`, which
is not in the database and not in the backups. A database restored from before it brings the tenant
back; the worker reads the file at start and queues the purge again for anything it finds, so the
tenant does not stay restored. Participant-requested deletions are recorded the same way.

## Security incidents

For the day something is wrong that is not a failed job: a stolen laptop, a leaked key, a tenant
admin who reports that a stranger signed in, a vulnerability report. The threat model and what is
and is not defended is [`SECURITY.md`](SECURITY.md); this is what to do.

### Incident response

You are the processor of your tenants' data and, to them, the platform. Three clocks run, and only
one is yours: you tell the **controller (the tenant) without undue delay** that personal data was
or may have been exposed; the controller then has 72 hours to notify the authority (GDPR Art. 33).
So the order is: stop the bleeding, preserve what you have, find out what was reachable, tell the
tenants, then fix and write it down.

**1. Contain (minutes).**

- One account: Admin → Users → **Disable** the user. Their sessions end at once (D-161), including
  the 8-hour ones already issued. For a tenant: Operator → Tenants → **Suspend**; staff, participant
  tokens, jobs and mail stop (D-86), and `privacy.*` deletion jobs still run.
- An interview link being abused: close the campaign (Admin → Campaigns → Close). The link then
  answers as closed.
- The whole site: `deploy/dc stop caddy` takes it off the internet and leaves the data alone.
  `deploy/dc start caddy` brings it back.
- Do **not** run `deploy/dc down -v`, restart containers "to clear it" before you have taken the
  logs below, or delete anything.

**2. Preserve (before you change anything else).**

```bash
mkdir -p ~/incident-$(date +%F) && cd ~/incident-$(date +%F)
deploy/dc logs --since 72h --no-color api web worker caddy > logs.txt   # tokens are already redacted (D-223)
deploy/dc exec -T backup /usr/local/bin/backup.sh once                  # a dump of the state as it is now
deploy/dc exec -T postgres psql -U app -d ai_discovery -c "select * from audit_chain_verify();" > chain.txt
```

An empty `chain.txt` means no audit row was altered. A row listed there is itself an incident
(see [audit.chain_broken](#auditchain_broken)).

**3. Scope: what could they reach?** Read the tenant's audit log (Admin → Audit, or the table) for
the window. Three actions answer most of it: `operator.access` (the platform looked inside the
tenant: it should only ever be you), `session.read` and `session.list_read` (who read transcripts and
the list of who took part), `campaign.sessions_export`, `report.export`, `spec.export`, and
`provider.*` / `settings.update` (what was changed). The `UsageCounter` table shows abuse of an open
link (`select key, count, "windowStart" from "UsageCounter" order by "windowStart" desc limit 50`).
A compromised **staff** account reaches that tenant only; a compromised **platform operator**
account reaches every tenant; the **host** reaches everything.

**4. Tell.** The tenant's admins, in writing, without waiting for certainty: what happened, what
data of theirs was or may have been reachable, since when, what you did, what they should do.
Keep it factual. Say what you do not know yet and when you will. If a tenant asks for the audit
rows for the window, export them from the audit log; they hold actors, actions and targets, never
content.

**5. Fix, then record.** Rotate whatever the section below says; patch; then add what happened,
what you changed and what you will watch to your own notes, and open a decision row if a control
changed.

### Key compromise: which secret leaked

Each secret opens something different. Rotate the one that leaked first, then judge from the
incident whether the ones next to it were exposed too. After any rotation, look at
[Platform health](#looking-at-the-platform): nothing red.

| What leaked                               | What it opens                                                       | Rotate                                                                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_SECRET`                             | Forging any staff session, including the operator's                 | New `AUTH_SECRET` in `deploy/.env`, `deploy/dc up -d --force-recreate api web`. Everyone is signed out. No data moves                              |
| The internal header (`x-internal-auth`)   | The magic-link token store (D-260)                                  | Same as `AUTH_SECRET`: it is derived from it. A leak of only the derived value does not give the session key                                       |
| `PLATFORM_ENCRYPTION_KEY`                 | Stored provider keys, SMTP passwords, GitHub tokens, export sealing | The [crypto.rekey](#cryptorekey) drill, **and** rotate the provider keys at the providers: the ciphertext was exposed                              |
| A provider API key                        | Spend at that provider                                              | Rotate at the provider, then Admin → Providers (or Operator → Providers) to store the new one                                                      |
| SMTP credentials                          | Sending mail as the platform                                        | New credentials at the relay; Settings → email (tenant) or `SMTP_USER`/`SMTP_PASSWORD` (platform), then `deploy/dc up -d`                          |
| `BACKUP_AGE_IDENTITY`                     | Reading every backup and offsite copy                               | New key pair (`deploy/ensure-backup-key.sh`), a fresh backup, keep the old identity until old backups age out; consider the offsite bucket exposed |
| Offsite bucket credentials                | The bucket's contents (encrypted dumps)                             | Rotate at the storage provider, update `deploy/.env`, `deploy/dc up -d backup`                                                                     |
| `POSTGRES_PASSWORD` / `APP_DB_PASSWORD`   | The database                                                        | See [DEPLOY.md](DEPLOY.md#secrets-you-cannot-casually-rotate): change, recreate; assume the data was readable                                      |
| The host (root, or `deploy/.env`)         | Everything above                                                    | Rebuild the host from the repository, restore from a backup taken **before** the incident, rotate every secret in this table, tell every tenant    |
| A tenant admin's GitHub token (spec push) | That repository, with their scope                                   | It is never stored by the platform; the admin revokes it at GitHub                                                                                 |

**A leaked secret you have not rotated is a standing incident.** If you cannot rotate now
(`PLATFORM_ENCRYPTION_KEY` with a campaign open: see the dedupe note in
[crypto.rekey](#cryptorekey)), suspend what depends on it and write down the date you decided to
carry the risk.

**Checking that the old secret is dead.** `AUTH_SECRET`: a session cookie from before the change
answers 401 on `GET /api/v1/me`. `PLATFORM_ENCRYPTION_KEY`: `GET /operator/crypto/status` lists one
key and `pending: 0`. Provider key: the provider's own usage page shows no calls with the old one.

### Reporting a vulnerability to you

The address is in `apps/web/public/.well-known/security.txt` and `SECURITY.md`. Acknowledge within
three working days, reproduce it on a copy (never on a tenant's data), and treat anything that
reads across tenants or exposes a secret as an incident from step 1 above. Keep the reporter
informed; the disclosure policy is 90 days, coordinated.

## What lives outside the box

Two things, and the repository cannot hold either:

1. **`deploy/.env`.** It holds the database passwords, `PLATFORM_ENCRYPTION_KEY` and the backup
   identity: the keys to the data, the stored provider keys and the backups. Copy it to your
   password manager when it is created and whenever it changes.
2. **The offsite bucket's credentials**, which are in `deploy/.env` too, and the bucket itself.

Everything else (compose, scripts, the alert catalog, the checks, this document) is in the repository
and is what a new host is built from.

## Not yet

Planned in the operations program and not built, so that nothing here is read as a promise: load
and chaos tests and the recorded owner drills (the tables above are where they are written down),
the tenant-facing export of the whole organization's data (`POST /privacy/export`), and the
what's-new feed. Everything else on this page is in the repository and has a test.
