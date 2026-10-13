# Operations program: C+ to A for a solo operator

Scope: everything lives in the repository (compose, scripts, TypeScript, docs, dashboards). No runbook step that a tired person has to remember. Nothing in the repo was modified.

## 0. What the code says today (the facts the program is built on)

| Fact (verified in code)                                                                                                                                                                              | Where                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Budget warnings end in `log.warn`, in two places, with no shared hook                                                                                                                                | `apps/api/src/context.ts:62-64`, `apps/worker/src/main.ts:37-39` (both pass `onBudgetWarning` into `CallerFactory`) |
| Budget exceeded throws from `ModelCaller.prepare`/`transcribe`/`speak`/`embed`; no hook exists for it                                                                                                | `packages/ai/src/callModel.ts:137-139, 178-180, 233-235, 292-295, 356-359`                                          |
| Participant is told "The organizer has been notified"; nobody is                                                                                                                                     | `apps/api/src/modules/sessions/turn-runner.ts:171`                                                                  |
| `cost.onBudgetExceeded: "downgrade"` is a catalog key nothing reads                                                                                                                                  | `packages/shared/src/settings.ts:166-172`; `grep` finds no reader                                                   |
| Job failure handler logs and rethrows; dead-letter queues exist (`<name>.dead`) but nothing reads them; `queueStats()` has no callers                                                                | `packages/core/src/jobs/pg-boss.ts:33-43, 92-108, 110-123`; `apps/worker/src/main.ts:76-78`                         |
| No `expireInSeconds` anywhere: pg-boss default (15 min) redelivers a long `analysis.run`                                                                                                             | `packages/core/src/jobs/definitions.ts` has only `retryLimit`                                                       |
| Worker healthcheck is `kill -0 1`                                                                                                                                                                    | `deploy/compose.prod.yml:190-196`                                                                                   |
| Worker is handed `OTEL_EXPORTER_OTLP_ENDPOINT` by compose but its config schema does not read it, and `startTelemetry` is API-only                                                                   | `deploy/compose.prod.yml:185`, `apps/worker/src/config.ts`, `apps/api/src/otel.ts`                                  |
| API logs have request id only; no tenant or session id; `req.url` (with `/p/<linkToken>`) is logged unredacted                                                                                       | `apps/api/src/lib/logger.ts`, `apps/api/src/auth/plugin.ts` (no child logger)                                       |
| `/stats` has `_avg.latencyMs` only; no first-token timing is captured anywhere; voice latency is one averaged `voice.live` event per session                                                         | `apps/api/src/modules/stats/routes.ts:17-23`, `apps/api/src/modules/participant/voice-live.ts:681-703`              |
| Ledger: `transcribe` records `emptyUsage()`; TTS is billed as `chars/4` output tokens; an abandoned chat stream records zero usage (the `done` event never arrives, `finally` writes `emptyUsage()`) | `callModel.ts:146-153, 304-338, 78-96`                                                                              |
| `LlmCall` has no audio/character/first-token columns; `ModelPrice` has three per-Mtok prices                                                                                                         | `packages/db/prisma/schema.prisma:507-520, 553-579`                                                                 |
| Backup healthcheck proves the loop is alive, not that the last backup succeeded; a failed run logs and the heartbeat keeps ticking                                                                   | `deploy/backup.sh:98-103`, `compose.prod.yml:301-308`                                                               |
| Backups are plaintext, on-host; offsite is a cron suggestion in prose                                                                                                                                | `docs/DEPLOY.md` "The volume is on this machine"                                                                    |
| Images are `aidp-server:latest`/`aidp-web:latest`, built on the VPS; rollback is `git checkout` + rebuild                                                                                            | `compose.prod.yml:20-23, 58-61`, `DEPLOY.md` "Rolling back"                                                         |
| Compose project has no `name:`; volumes are `deploy_*` by directory accident                                                                                                                         | `compose.prod.yml`, `DEPLOY.md` "Where the data lives"                                                              |
| Memory limits: 1536+2560+1024+768+256+512 = 6656 MB on a doc-stated 4 GB floor                                                                                                                       | `compose.prod.yml` `deploy.resources`                                                                               |
| Tenant suspension: staff tokens _are_ refused for a non-active company (returns anonymous), but participant tokens, link opens and jobs never check `Company.status`                                 | `apps/api/src/auth/principal.ts:48` vs `:56-70`, `apps/api/src/modules/participant/service.ts:40-75`                |
| Operator tenant creation makes `Company`, `User(admin)`, `Budget`; sends no invitation; no onboarding state                                                                                          | `apps/api/src/modules/operator/routes.ts:61-103`                                                                    |
| `SettingDef` has no `since`; there is no release-notes artefact                                                                                                                                      | `packages/shared/src/settings.ts:12-20`                                                                             |
| The status report's finding 9 overstates: staff suspension is enforced at the API, participant and job paths are not                                                                                 | as above                                                                                                            |
| Spec 12 and spec 10 name an `infra/` directory that does not exist                                                                                                                                   | `docs/spec/12-operations.md:3`, `docs/spec/10-architecture.md:44`                                                   |

---

## 1. Alerting

### 1.1 Shape

New folder `packages/core/src/alerts/`:

```
alerts/
  port.ts            Alert, AlertKind, Severity, Audience, AlertPort, MemoryAlerts (fake)
  kinds.ts           the catalog: one row per kind (severity, audience, default repeat window, runbook anchor)
  router.ts          AlertRouter implements AlertPort: dedupe + rate limit (OpsAlert table) + fan-out
  email-alerts.ts    EmailAlertChannel (reuses SettingsEmail: companyId undefined = platform SMTP)
  webhook-alerts.ts  WebhookAlertChannel: ntfy | slack | generic JSON, picked by setting
  prisma-state.ts    PrismaAlertState (dedupe/rate-limit store) + MemoryAlertState
  index.ts
```

```ts
// port.ts
export type Severity = "info" | "warning" | "critical";
export type Audience = "operator" | "tenant_admins";

export interface Alert {
  kind: AlertKind;                 // "budget.exceeded", "job.dead_lettered", ...
  severity: Severity;
  audience: Audience[];            // from the catalog; a source may narrow it
  /** Dedupe key. Same key within the repeat window = counted, not re-sent. */
  key: string;                     // e.g. `budget.exceeded:campaign:${id}:2026-10`
  companyId?: string;              // required when audience includes tenant_admins
  title: string;                   // subject line without the prefix
  message: string;                 // plain text body, no PII (see 3.4)
  context?: Record<string, string | number | boolean>;  // ids and numbers only
  links?: { label: string; url: string }[];  // admin deep links built from PUBLIC_WEB_URL
  occurredAt?: Date;
}

export interface AlertPort {
  /** Never throws. Returns what happened so a caller can tell the user the truth. */
  raise(alert: Alert): Promise<{ delivered: boolean; suppressed: "duplicate" | "rate_limited" | "below_min_severity" | null }>;
  /** Clears a key so the next occurrence is sent again (e.g. backup succeeded after a failure). */
  resolve(key: string): Promise<void>;
}

export class MemoryAlerts implements AlertPort { readonly raised: Alert[] = []; ... }
```

`AlertRouter` logic:

1. Severity floor: drop if below `ops.alertMinSeverity` (platform setting, default `info` for webhook, `warning` for email; implemented as per-channel floors `ops.alertEmailMinSeverity`, `ops.alertWebhookMinSeverity`).
2. Dedupe: upsert `OpsAlert` by `key`; if `notifiedAt` is within `repeatMinutes` (catalog default 60, override `ops.alertRepeatMinutes`) and severity did not escalate, increment `count` and return `suppressed: "duplicate"`.
3. Global rate limit: at most `ops.alertMaxPerHour` (default 30) notifications per audience per hour; beyond it, the router sends exactly one `alerts.storm` critical ("47 alerts suppressed in the last hour, most common: provider.error_rate") and suppresses the rest.
4. Fan-out: operator alerts go to every operator channel configured; tenant alerts go by email to the tenant's recipients (`notifications.recipients`, default `"admins"` = every `User` with role `admin` in that company), through `SettingsEmail` with `companyId` set so the tenant's own SMTP/branding applies.
5. Every notification is also written to the audit log (`action: "alert.sent"`, `companyId` of the tenant or the platform tenant) so the admin UI can show a history.

Why a table and not in-memory state: API and worker both raise alerts, and a restart must not re-page. `OpsAlert` (new Prisma model: `id, key @unique, kind, severity, companyId?, title, count, firstAt, lastAt, notifiedAt?, resolvedAt?, context Json`) carries a nullable `companyId` and therefore needs an RLS policy like `Provider`/`Route` (visible untenanted when null; the preflight will otherwise refuse to start, correctly).

Shell-level alerts (things that fire when the app cannot) use a second, tiny path: a `ops-notify` sidecar (`curlimages/curl`, about 10 MB, 32 MB limit) running `deploy/ops/notify.sh`, which watches `/ops-state/alerts/*.json` and posts each file to the same webhook and, via `curl smtp://`, the same operator email, then moves it to `/ops-state/alerts/sent/`. Shell producers (`preflight.sh`, `backup.sh`, `restore-drill.sh`, `notify.sh`'s own watchdog) write that JSON with the same field names as `Alert`, so the operator sees one format. New named volume `ops_state`, mounted rw into `preflight`, `backup`, `worker`, `api`, and ro into `ops-notify` (which also creates `/ops-state/{alerts,status,heartbeat}` mode 1777 at start, because the writers run as three different uids).

### 1.2 Settings (all in `packages/shared/src/settings.ts`, category `ops` and `notifications`)

| Key                                                         | Scope            | Default                                                                 | Purpose                                  |
| ----------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------- | ---------------------------------------- |
| `ops.alertEmail`                                            | platform         | `""` (falls back to `ALERT_EMAIL` env, then `BOOTSTRAP_OPERATOR_EMAIL`) | operator address                         |
| `ops.alertWebhookUrl`                                       | platform, secret | `""`                                                                    | ntfy topic URL or Slack incoming webhook |
| `ops.alertWebhookFormat`                                    | platform         | `ntfy` (`ntfy                                                           | slack                                    | generic`) | body shape |
| `ops.alertEmailMinSeverity` / `ops.alertWebhookMinSeverity` | platform         | `warning` / `info`                                                      | floors                                   |
| `ops.alertRepeatMinutes`                                    | platform         | 60                                                                      | dedupe window                            |
| `ops.alertMaxPerHour`                                       | platform         | 30                                                                      | storm guard                              |
| `ops.diskWarnPercent` / `ops.diskCriticalPercent`           | platform         | 80 / 90                                                                 |                                          |
| `ops.providerErrorRateWarn`                                 | platform         | 0.25 (min 10 calls / 10 min)                                            |                                          |
| `ops.backupMaxAgeHours`                                     | platform         | 26                                                                      | "missing" threshold                      |
| `notifications.recipients`                                  | tenant           | `"admins"` or `string[]`                                                | who in the tenant gets mail              |
| `notifications.budgetWarnings`                              | tenant           | true                                                                    | spec 07                                  |
| `notifications.completionNotices`                           | tenant           | true                                                                    | campaign reached threshold               |
| `notifications.analysisReady`                               | tenant           | true                                                                    | analysis done or failed                  |

Env additions (`deploy/compose.prod.yml`, `generate-env.sh`): `ALERT_EMAIL`, `ALERT_WEBHOOK_URL` (both optional; used by `ops-notify` and as fallback by the app before any setting exists).

### 1.3 Catalog and wiring points

Prefix: operator subjects `[aidp <PUBLIC_HOSTNAME>]`, tenant subjects `[<branding.productName>]`. Body shape (text): one-line what, one-line where (ids), one-line numbers, one line "what to do" that is the `docs/OPERATIONS.md` anchor URL for that kind, and a deep link. Webhook JSON (generic): `{kind, severity, key, title, message, companyId, occurredAt, count, links[], runbook}`; ntfy adds `priority` (info 3, warning 4, critical 5) and `tags`; Slack sends `text` plus one `section` block.

| Kind                                            | Severity           | Audience                               | Fires from (file:line)                                                                                                                                                                                                                                                                     | Dedupe key                                           | Operator receives                                                                                                                        | Tenant admin receives                                                                                               |
| ----------------------------------------------- | ------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `budget.warning`                                | info               | operator (webhook only), tenant_admins | `CallerFactory.forCompany` builds the `onBudgetWarning` callback itself (`packages/core/src/providers/caller-factory.ts:42-55`) and raises per warning; the two `log.warn` sites in `context.ts:62` and `worker/main.ts:37` go away                                                        | `budget.warning:<scope>:<scopeId>:<yyyy-mm>:<tier 80 | 90>`                                                                                                                                     | "Budget warning: tenant Acme at 83% (16 600 of 20 000 c)"                                                           | "Your <campaign name> budget is at 83% (€166 of €200). Interviews continue; at 100% they pause." + link to Admin → Budgets |
| `budget.exceeded`                               | warning            | operator, tenant_admins                | new `onBudgetExceeded(ctx, check)` in `ModelCallerDeps` (`callModel.ts:63-70`), called at every `throw new BudgetExceededError` (`:139, :180, :235, :294, :358`); wired in `CallerFactory` like the warning. The turn runner keeps pausing the session (`turn-runner.ts:165-166`)          | `budget.exceeded:<scope>:<scopeId>:<yyyy-mm>`        | "Budget exhausted: campaign 'Q4 discovery' (Acme). 3 sessions paused."                                                                   | "Interviews for 'Q4 discovery' are paused: the budget of €200 is used up. Raise the budget or wait for next month." |
| `job.dead_lettered`                             | critical           | operator                               | `BossJobs.consume` (`pg-boss.ts:92-108`): pass `includeMetadata: true` to `work()`, and in the catch, if `job.retryCount >= job.retryLimit` call `onDeadLetter(name, job)`; the worker's `failed()` in `main.ts:76-78` raises. Also from the sweep (1.4) for jobs dead-lettered by a crash | `job.dead_lettered:<queue>:<jobId>`                  | "Job dead-lettered: analysis.run after 3 attempts (tenant Acme, analysis cx…). Retry: /admin/operator/jobs"                              | nothing (tenant sees `Analysis failed` in the UI; `analysis.failed` below covers mail)                              |
| `job.stuck`                                     | warning            | operator                               | `ops.health-sweep` (1.4)                                                                                                                                                                                                                                                                   | `job.stuck:<queue>`                                  | "7 jobs active past expiry in session.extract; pg-boss maintenance may be dead"                                                          | —                                                                                                                   |
| `backup.failed`                                 | critical           | operator                               | `backup.sh` writes `/ops-state/status/backup.json` `{lastRunAt, lastResult, lastSuccessAt, dump, sizeBytes, counts}` after every run; worker sweep reads it; `resolve()` when the next run succeeds                                                                                        | `backup.failed`                                      | "Nightly backup FAILED at 03:20Z: pg_dump returned 1. Last good: 2026-10-11T03:20Z"                                                      | —                                                                                                                   |
| `backup.missing`                                | critical           | operator                               | sweep: `lastSuccessAt` older than `ops.backupMaxAgeHours`                                                                                                                                                                                                                                  | `backup.missing`                                     | "No successful backup for 31 h"                                                                                                          | —                                                                                                                   |
| `backup.offsite_failed` / `backup.drill_failed` | critical           | operator                               | `backup.sh` (rclone step) and `restore-drill.sh` write alert files directly (they run in the backup container)                                                                                                                                                                             | per kind                                             | "Weekly restore drill FAILED: Session rows 1 204 restored vs 1 311 in manifest"                                                          | —                                                                                                                   |
| `disk.high`                                     | warning / critical | operator                               | sweep: `fs.statfs("/uploads")` (Node 22) in the worker; `ops-notify` does the same with `df` as the dead-man path                                                                                                                                                                          | `disk.high:<tier>`                                   | "Disk 86% used (34.4 of 40 GB). Largest: /var/lib/docker 29 GB"                                                                          | —                                                                                                                   |
| `provider.error_rate`                           | warning            | operator                               | sweep: `LlmCall` grouped by `providerId,status` over 10 min; also immediately from the circuit breaker (8.4) `provider.circuit_open`                                                                                                                                                       | `provider.error_rate:<providerId>`                   | "Provider 'OpenRouter (platform)': 14 of 38 calls failed in 10 min (37%). Codes: 429×9, 5xx×5"                                           | —                                                                                                                   |
| `rls.preflight_failed`                          | critical           | operator                               | `deploy/preflight.sh` `fail()` writes `/ops-state/alerts/preflight-<ts>.json` before `exit 1`; `ops-notify` posts it                                                                                                                                                                       | `rls.preflight_failed`                               | "RLS preflight FAILED on boot: 'these tables carry a companyId but have no row-level security: OpsAlert'. api and worker did not start." | —                                                                                                                   |
| `tls.renewal`                                   | critical           | operator                               | `ops-notify` daily: `curl -sv --resolve "$PUBLIC_HOSTNAME:443:caddy" https://$PUBLIC_HOSTNAME/ 2>&1 \| grep 'expire date'`; alert when < 14 days                                                                                                                                           | `tls.renewal`                                        | "Certificate for pilot.example.com expires in 9 days; Caddy has not renewed. `dc logs caddy \| grep -i acme`"                            | —                                                                                                                   |
| `worker.heartbeat_stale`                        | critical           | operator                               | `ops-notify` watchdog: `/ops-state/heartbeat/worker` mtime > 300 s, or `http://api:4000/api/v1/health/ready` not 200 for 5 min (`api.down`)                                                                                                                                                | per kind                                             | "Worker heartbeat stale for 6 min; container may be restarting or pg-boss cannot reach Postgres"                                         | —                                                                                                                   |
| `tenant.limit_reached`                          | info / warning     | operator / tenant_admins               | enforcement points in 7.4                                                                                                                                                                                                                                                                  | `tenant.limit:<companyId>:<limit>:<yyyy-mm>`         | "Acme reached sessionsPerMonth (500)"                                                                                                    | "Your plan's 500 interviews this month are used up; new participants see a 'closed' page"                           |
| `campaign.threshold_reached`                    | info               | tenant_admins                          | `AnalysisService.maybeQueueForCampaign` (`packages/core/src/analysis/service.ts:~100-115`) when `completed >= needed`                                                                                                                                                                      | `campaign.threshold:<campaignId>`                    | —                                                                                                                                        | "'Q4 discovery' reached 12 completed interviews; analysis is running"                                               |
| `analysis.ready` / `analysis.failed`            | info / warning     | tenant_admins (+ operator on failed)   | `service.ts:236` (done) and `:260` (failed)                                                                                                                                                                                                                                                | `analysis.<state>:<analysisId>`                      | failed only                                                                                                                              | "Report for 'Q4 discovery' is ready" + link                                                                         |

The participant string. `turn-runner.ts:171` becomes two strings chosen by the `raise()` result the runner gets back from the hook (the hook stores the last result on the thrown error or the runner raises itself with the same key, which dedupes): delivered → "This interview is paused because its budget is used up. Your answers are saved and the organizer has been notified."; not delivered → "This interview is paused because its budget is used up. Your answers are saved; please contact the organizer." Also move these three messages into the shared i18n catalog (`apps/web/src/i18n`) keyed by `code`, since the API currently ships English only while the web renders Finnish.

### 1.4 The sweep that makes "nothing is silent" true

New recurring job `ops.health-sweep` (every 5 min, `singletonKey`, concurrency 1, `expireInSeconds: 240`) in `packages/core/src/jobs/definitions.ts` + handler in `apps/worker/src/handlers.ts`, implemented in `packages/core/src/ops/health-sweep.ts` with a `HealthInputs` port (so the test feeds fake queue stats, fake backup.json, fake statfs). It: reads `queueStats()` and `pgboss.job` for stuck/dead counts (`BossJobs.inspect()` added next to `queueStats`), reads `/ops-state/status/backup.json`, calls `statfs`, aggregates provider errors, computes voice/turn p95 for the gauges in section 3, raises or resolves the alerts above, and sets the Prometheus gauges. One place, one test file, one runbook section.

Tests: `packages/core/test/alerts.test.ts` (router dedupe, rate limit, floors, tenant recipient resolution with `MemoryEmail`), `packages/core/test/health-sweep.test.ts` (each alert source with fake inputs), `apps/api/test/budget-alerts.e2e.test.ts` (fake provider + budget of 1 cent → `MemoryAlerts.raised` has `budget.exceeded`, session paused, participant message is the "notified" variant), and a doc-coupling test `docs/test/operations-anchors.test.ts` asserting every `AlertKind` in `kinds.ts` has a `### <kind>` heading in `docs/OPERATIONS.md`.

---

## 2. Job administration

### 2.1 `expireInSeconds` per job (`packages/core/src/jobs/definitions.ts`, applied in `BossJobs.start()` `createQueue` options and also per `send` so a changed value applies to already-created queues)

| Job                                       | expire | retry | Rationale                                                      |
| ----------------------------------------- | ------ | ----- | -------------------------------------------------------------- |
| `session.summarize`                       | 120    | 3     | one model call                                                 |
| `session.extract`                         | 180    | 3     | batched calls                                                  |
| `email.send`                              | 60     | 5     | SMTP timeout is 30 s                                           |
| `privacy.delete-session`                  | 300    | 5     | storage prefix delete                                          |
| `privacy.retention-sweep`                 | 1800   | 2     | bounded at 50×200                                              |
| `auth.prune-verification-tokens`          | 120    | 2     |                                                                |
| `attachment.ingest`                       | 600    | 2     | two model calls + embeddings                                   |
| `analysis.run`                            | 3600   | 2     | the long one; today it is redelivered at 15 min and runs twice |
| `spec.generate`                           | 1800   | 2     |                                                                |
| `ops.health-sweep`                        | 240    | 1     |                                                                |
| `billing.statement` (4.5)                 | 900    | 3     |                                                                |
| `tenant.export` / `tenant.offboard` (7.3) | 3600   | 2     |                                                                |

Also `retentionMinutes` for completed jobs (default 14 days of `pgboss.job` rows is fine; set `.dead` queues to 30 days so the operator has time to look).

### 2.2 Routes (`apps/api/src/modules/operator/jobs.ts`, registered from `operator/routes.ts`; logic in `packages/core/src/jobs/admin.ts` so the worker's sweep reuses it)

- `GET /operator/jobs` → `[{ name, queued, active, deadLettered, oldestQueuedAt, expireInSeconds, retryLimit, lastFailure: {at, jobId} | null }]` from `queueStats()` plus one `$queryRaw` over `pgboss.job` (the app role owns the pgboss tables, see `deploy/grants.sql`).
- `GET /operator/jobs/dead?queue=analysis.run&limit=50` → rows from `pgboss.job where name = '<queue>.dead'`: `id, createdOn, data (ids only, see redaction), retryCount, output (error message, 500 chars)`.
- `POST /operator/jobs/dead/:queue/:id/retry` → `boss.getJobById('<queue>.dead', id)` → `boss.send(queue, job.data, {expireInSeconds})` → `boss.deleteJob('<queue>.dead', id)`; audit `job.retry` with `targetId: jobId` on the job's `companyId` (or the platform). `POST .../discard` deletes and audits `job.discard`. (pg-boss 12 API names from the installed major; confirm `getJobById`/`deleteJob` signatures against `node_modules/pg-boss/types.d.ts` when implementing.)
- `POST /operator/jobs/run/:name` for the parameterless recurring jobs (`privacy.retention-sweep`, `ops.health-sweep`, `billing.statement`) so "run it now" is a button, not a `psql` session.

All under `requireStaff("platform_operator")`, rate-limited by the global limiter.

### 2.3 Operator UI

`apps/web/src/app/admin/operator/jobs/page.tsx` + `components/admin/operator/JobsPanel.tsx`: a queue table (name, queued, active, dead with a red badge, oldest queued age, "Run now" for schedulable ones), and below it the dead-letter list for the selected queue with payload ids, attempt count, error excerpt, and Retry / Discard with the confirmation dialog pattern spec 19 asks for. Add the entry to the operator navigation in `components/admin/AdminShell.tsx`. Strings in both locales.

### 2.4 Stuck-job sweeper

Part of `ops.health-sweep`: `select name, count(*) from pgboss.job where state = 'active' and started_on < now() - (expire_in + interval '5 minutes') group by name`. pg-boss's own maintenance should have expired these, so a non-zero count means two things at once and the alert says so (`job.stuck`). The sweep does not fail them itself; it is a detector. The fix for the actual cause (maintenance not running) is the worker self-restart in 2.5.

### 2.5 Worker heartbeat (design)

`apps/worker/src/heartbeat.ts`: every 30 s, `await jobs.boss.getQueueStats("ops.health-sweep")` (any cheap pg-boss call that needs a live connection); on success `fs.utimes(HEARTBEAT_FILE, now, now)`; on failure, count; after 3 consecutive failures log `worker: pg-boss unreachable, exiting for restart` and `process.exit(1)` so `restart: unless-stopped` brings it back (Docker never restarts an _unhealthy_ container by itself; the self-exit is what turns the healthcheck into a repair). `HEARTBEAT_FILE=/ops-state/heartbeat/worker`. Compose:

```yaml
healthcheck:
  test: ["CMD-SHELL", "test -f /ops-state/heartbeat/worker && [ $$(( $$(date +%s) - $$(stat -c %Y /ops-state/heartbeat/worker) )) -lt 90 ]"]
  interval: 30s; timeout: 5s; retries: 3; start_period: 60s
```

The `ops-notify` watchdog reads the same file at 300 s for the alert, so a worker crash-looping fast enough to keep the mtime fresh is still caught by the dead-letter sweep, and one that stays down is caught here. Test: `apps/worker/test/heartbeat.test.ts` with a fake boss that fails N times.

---

## 3. Observability

### 3.1 Tracing in the worker, joined to the API trace

- Move `apps/api/src/otel.ts` to `packages/core/src/telemetry/otel.ts` (same lazy import; the 40 MB cost stays behind the env check). Worker `config.ts` gets `OTEL_EXPORTER_OTLP_ENDPOINT`; `main.ts` calls `startTelemetry("aidp-worker", …)` first, before `PrismaClient` is constructed (auto-instrumentation patches at import time). Add `@opentelemetry/api` to `packages/core` and `packages/ai`.
- Propagation through the payload: `definitions.ts` wraps every schema with `withTrace(schema) = schema.extend({ traceparent: z.string().optional(), tracestate: z.string().optional() })`. `BossJobs.publish` injects via `propagation.inject(context.active(), carrier)`; `BossJobs.consume` extracts, and runs the handler inside `tracer.startActiveSpan("job <name>", { kind: SpanKind.CONSUMER }, extractedCtx, …)` with attributes `job.name, job.id, job.attempt, tenant.id, session.id|analysis.id|…`. Child span (same trace id) rather than a link, because the operator wants one trace per session; a job that runs an hour later is still that session's work. `MemoryJobPublisher` keeps the carrier so a test asserts it is present.

### 3.2 Custom spans (names are stable strings used by dashboards)

| Span              | Where                                                                                                                     | Attributes                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `session.turn`    | `apps/api/src/modules/sessions/turn-runner.ts` around the generator (`runTurn` / the async generator that takes the lock) | `tenant.id, session.id, campaign.id, template.key, turn.index, turn.mode (chat | options                                                                  | voice), turn.first_token_ms, turn.ended` |
| `model.call`      | `ModelCaller.chat/complete/transcribe/transcribeStream/embed/speak` in `packages/ai/src/callModel.ts`                     | `ai.purpose, ai.provider_id, ai.model, ai.status, ai.tokens.input              | cache_read                                                               | cache_write                              | output, ai.audio_seconds, ai.tts_chars, ai.cost_cents, ai.first_token_ms, ai.prompt_version, ai.estimated` |
| `voice.utterance` | `voice-live.ts` from `speech_started` to the first spoken audio frame                                                     | `voice.mode (utterance                                                         | stream), voice.first_partial_ms, voice.first_word_ms, voice.interrupted` |
| `job <name>`      | `BossJobs.consume`                                                                                                        | above                                                                          |
| `analysis.stage`  | `AnalysisService.run` per stage (extract, cluster, score, report)                                                         | `analysis.id, stage, facts, clusters`                                          |

The `Logger` port in `packages/ai` stays small; spans are created through a `Tracer` obtained from `@opentelemetry/api` (`trace.getTracer("aidp")`), which is a no-op when no SDK started, so tests pay nothing.

### 3.3 Tenant and session ids in every log line

`apps/api/src/auth/plugin.ts` `onRequest` hook, after the principal is resolved:

```ts
request.log = request.log.child({
  tenantId: request.companyId || undefined,
  principal: p.kind,
  ...(p.kind === "staff" ? { userId: p.userId } : {}),
  ...(p.kind === "participant" ? { sessionId: p.sessionId } : {}),
  ...(traceId ? { traceId, spanId } : {}), // from trace.getActiveSpan()?.spanContext()
});
```

Fastify's per-request `request.log` is already a child of `ctx.log` with `reqId`; route code that uses `ctx.log` should switch to `req.log` (an eslint `no-restricted-syntax` rule for `ctx.log.` inside `routes.ts`/`service.ts` files makes it stick). The engine's `Logger` port gets a `child(bindings)` method; `EngineFactory` and `turn-runner` pass `req.log`-derived loggers down. Worker: `BossJobs.consume` builds `log.child({ job: name, jobId, attempt, tenantId: payload.companyId, sessionId: payload.sessionId, traceId })` and hands it to the handler as a second argument (`Handlers` type changes to `(payload, log) => Promise<void>`). pino `mixin` adds `traceId` globally so Grafana can link logs to traces later if Loki is added.

### 3.4 PII redaction policy (`docs/OPERATIONS.md` "What is never logged", enforced in `apps/api/src/lib/logger.ts` and `apps/worker/src/main.ts` via a shared `packages/core/src/telemetry/redaction.ts`)

Never in a log line, at any level, in any environment except `NODE_ENV=development`:

1. Tokens: bearer/cookie headers (already), participant tokens and link tokens in URLs. Add a `serializers.req` that rewrites `req.url` with `/p/<redacted>` for `^/api/v1/p/[^/]+$` and `/p/r/<redacted>`, and strips every query string (magic-link `token=` lands in Auth.js logs otherwise). Caddy's access log already sees the URL: add `log { format filter { request>uri query { delete token } } }` and, since link tokens are path segments, a `replace` filter for `/p/*`.
2. Transcript text: redact paths `*.text, *.content, *.transcript, *.messages, *.answer, *.summary, *.facts, *.payload.text, *.extractedText`. Handlers log counts and ids (`handlers.ts` already does; `"email (console)"` prints `to` and `subject` and is dev-only by construction, make that explicit with a `NODE_ENV` guard).
3. Emails: `*.email, *.to, *.adminEmail, *.identifier` → replaced by `sha256(value).slice(0,8)` via a custom `censor` function, so two lines about the same address are still correlatable.
4. Secrets: `*.apiKey, *.apiKeyEnc, *.password, *.smtpUrl, *.headers, *.authorization` (extends the existing list; `headers` because provider custom headers are credentials).
5. Upload filenames (`*.filename`) → extension only. Audit log and ledger are not logs and keep their data under RLS.

Test: `packages/core/test/redaction.test.ts` builds a pino instance into a buffer with the shared options and asserts each category disappears; the API e2e `participant-flow` test additionally asserts no line in the captured log contains the link token.

### 3.5 Metrics exporter

`prom-client` in `packages/core/src/telemetry/metrics.ts` (`Metrics` interface + `PromMetrics` + `NoopMetrics` fake), exposed by a 20-line `http.createServer` in `metrics-server.ts` on `METRICS_PORT` (api 9464, worker 9465), compose-network only, never through Caddy. Pull rather than OTLP push because it needs no collector and Prometheus is the smallest thing that can draw a p95.

| Metric                                                                                                                                                                                 | Type                                          | Labels                             | Source                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `aidp_turn_first_token_seconds`                                                                                                                                                        | histogram (buckets .25 .5 .75 1 1.5 2 3 5 10) | `purpose, provider, model, tenant` | `ModelCaller.chat`: time to first `text` event; also stored as `LlmCall.firstTokenMs` (new column) so `/stats` can compute p95 with `percentile_cont(0.95)` without Prometheus |
| `aidp_turn_duration_seconds`                                                                                                                                                           | histogram                                     | `tenant, mode`                     | `session.turn` span end                                                                                                                                                        |
| `aidp_model_call_duration_seconds`                                                                                                                                                     | histogram                                     | `purpose, provider, model, status` | `ModelCaller.record`                                                                                                                                                           |
| `aidp_model_tokens_total`                                                                                                                                                              | counter                                       | `kind, purpose, provider, tenant`  | same                                                                                                                                                                           |
| `aidp_model_cost_cents_total`                                                                                                                                                          | counter                                       | `purpose, provider, tenant`        | same                                                                                                                                                                           |
| `aidp_budget_blocked_total`                                                                                                                                                            | counter                                       | `scope, tenant`                    | `onBudgetExceeded`                                                                                                                                                             |
| `aidp_voice_first_word_seconds`, `aidp_voice_first_partial_seconds`                                                                                                                    | histogram (.25 .5 .75 1 1.25 1.5 2 3)         | `tenant, mode`                     | `voice-live.ts:404, :621` (today summed into averages)                                                                                                                         |
| `aidp_voice_interruptions_total`, `aidp_voice_stream_fallbacks_total`, `aidp_voice_audio_seconds_total`                                                                                | counter                                       | `tenant`                           | same file                                                                                                                                                                      |
| `aidp_jobs_queued`, `aidp_jobs_active`, `aidp_jobs_dead_lettered`                                                                                                                      | gauge                                         | `queue`                            | sweep                                                                                                                                                                          |
| `aidp_job_duration_seconds`                                                                                                                                                            | histogram                                     | `name, outcome`                    | `BossJobs.consume`                                                                                                                                                             |
| `aidp_job_failures_total`                                                                                                                                                              | counter                                       | `name, final`                      | same                                                                                                                                                                           |
| `aidp_http_request_duration_seconds`                                                                                                                                                   | histogram                                     | `route, method, status`            | Fastify `onResponse` hook (route pattern, not URL)                                                                                                                             |
| `aidp_sessions_active`                                                                                                                                                                 | gauge                                         | `tenant`                           | sweep: sessions with `updatedAt` in last 5 min                                                                                                                                 |
| `aidp_backup_last_success_timestamp_seconds`, `aidp_backup_last_size_bytes`, `aidp_backup_offsite_last_success_timestamp_seconds`, `aidp_restore_drill_last_success_timestamp_seconds` | gauge                                         |                                    | sweep from `backup.json`                                                                                                                                                       |
| `aidp_disk_used_ratio`                                                                                                                                                                 | gauge                                         | `mount`                            | sweep `statfs`                                                                                                                                                                 |
| `aidp_storage_bytes`                                                                                                                                                                   | gauge                                         | `tenant`                           | sweep: sum `Attachment.sizeBytes`                                                                                                                                              |
| `aidp_provider_errors_total`                                                                                                                                                           | counter                                       | `provider, code`                   | `ModelCaller.record` on error                                                                                                                                                  |
| `aidp_speech_model_state`                                                                                                                                                              | gauge (0..3)                                  |                                    | `ctx.speech.status()`                                                                                                                                                          |
| `aidp_alerts_sent_total`, `aidp_alerts_suppressed_total`                                                                                                                               | counter                                       | `kind, severity, audience`         | router                                                                                                                                                                         |
| default Node process metrics                                                                                                                                                           |                                               |                                    | `collectDefaultMetrics`                                                                                                                                                        |

`tenant` label is the company id (10 tenants is fine; the sweep drops label sets for suspended tenants).

### 3.6 `infra/observability` (optional compose profile; `docker compose -f deploy/compose.prod.yml -f infra/observability/compose.yml --profile observability up -d`)

```
infra/observability/
  compose.yml                 prometheus, tempo, grafana; limits 256M / 384M / 256M; 15 d / 7 d retention
  prometheus/prometheus.yml   scrape api:9464, worker:9465, caddy (enable `metrics` on :2020), postgres-exporter optional
  tempo/tempo.yml             single binary, OTLP http :4318, local WAL, 7 d
  grafana/provisioning/datasources.yml   Prometheus + Tempo (trace-to-metrics)
  grafana/provisioning/dashboards.yml
  grafana/dashboards/*.json   checked in; see below
  README.md                   sizes, how to reach Grafana (Caddy `handle_path /grafana/*` behind the staff session is M3; until then `ssh -L 3001:localhost:3000`)
```

`OTEL_EXPORTER_OTLP_ENDPOINT=http://tempo:4318` becomes the documented value. Sizing: the three add ~900 MB of limits; recommended on 8 GB, not on 4 GB (there the operator gets AlertPort, `/stats` p95 and `/operator/health`; Grafana Cloud's free tier over OTLP is the documented alternative and the same `OTEL_EXPORTER_OTLP_ENDPOINT` points at it).

### 3.7 SLOs and dashboards

| SLO                       | Target                                                      | Measured by                                                                                                                                        | Window                         |
| ------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Turn first token (NFR-01) | p95 < 2.0 s                                                 | `aidp_turn_first_token_seconds{purpose=~"interview_turn\|spec_turn"}`; `/stats` `firstTokenP95Ms` from `LlmCall.firstTokenMs`                      | 28 d, error budget 5% of turns |
| Voice first word          | p95 < 1.5 s (= `voice.targetFirstWordMs`)                   | `aidp_voice_first_word_seconds`                                                                                                                    | 28 d                           |
| Voice first caption       | p95 < 1.0 s (internal)                                      | `aidp_voice_first_partial_seconds`                                                                                                                 | 28 d                           |
| Job success               | ≥ 99.5%                                                     | `1 - dead_lettered / (completed + dead_lettered)` from `aidp_job_failures_total{final="true"}` and `aidp_job_duration_seconds_count{outcome="ok"}` | 7 d                            |
| Availability              | `/health/ready` 200 ≥ 99.5% (≈3.6 h/month, covers upgrades) | blackbox: Prometheus scrapes `api:4000/api/v1/health/ready` via `probe` or the sweep's gauge                                                       | 30 d                           |
| Backup freshness          | a _verified_ restorable backup < 26 h old, every week       | `aidp_backup_last_success_timestamp_seconds`, `aidp_restore_drill_last_success_timestamp_seconds`                                                  | always                         |
| Alert latency             | failure to notification < 5 min                             | sweep interval + router                                                                                                                            | always                         |
| Budget-block rate         | visible, no target (KPI per spec 12)                        | `aidp_budget_blocked_total`                                                                                                                        |                                |

Dashboards (JSON checked in): **Overview** (SLO tiles with burn, active sessions, queue depth, dead letters, disk, backup age, worker heartbeat age, speech model state); **Interview latency** (first-token p50/p95/p99 by provider/model, turn duration, error and refusal rates, cache-hit ratio from `tokens{kind=cache_read}/input`); **Voice** (first word, first partial, interruptions/hour, stream fallbacks, audio seconds by tenant); **Jobs** (per queue queued/active/dead, duration p95, failures, retries); **Cost** (cents/hour by tenant, purpose, provider; spend vs budget line gauges; tokens per interview); **Host and backups** (process RSS per service, disk, backup size trend, drill results, Postgres connections if exporter enabled).

---

## 4. Cost ledger completeness

### 4.1 Contracts (`packages/shared/src/chat.ts`, `ledger.ts`)

```ts
UsageSchema = z.object({
  inputTokens,
  cacheReadTokens,
  cacheWriteTokens,
  outputTokens, // as today
  audioSeconds: z.number().nonnegative().default(0), // STT input, TTS output duration when known
  ttsCharacters: z.number().int().nonnegative().default(0),
});
LedgerEntrySchema += { firstTokenMs: z.number().int().optional(), estimated: z.boolean().default(false) };
```

`ModelPrice` (`packages/ai/src/cost/pricing.ts` + Prisma): `audioPerMinute?: number` (USD per minute of audio), `ttsPerMChars?: number` (USD per million characters). `costCents` adds `audioSeconds/60 * audioPerMinute + ttsCharacters/1e6 * ttsPerMChars`. Seeds for `whisper-1` (0.006/min), `gpt-live-transcribe`, `tts-1` (15/M chars) in `SEED_PRICES` keyed to the OpenAI bootstrap provider; `local` whisper priced at 0. `importFromModels` maps OpenRouter/LiteLLM audio pricing fields when present. Admin price editor (`apps/web/src/app/admin/providers/[id]`) shows the two new columns. Migration `0013_ledger_audio_tts`: `LlmCall.audioSeconds Float @default(0)`, `ttsCharacters Int @default(0)`, `firstTokenMs Int?`, `estimated Boolean @default(false)`; `ModelPrice.audioPerMinute Float?`, `ttsPerMChars Float?`.

### 4.2 Recording the right numbers (`packages/ai/src/callModel.ts`)

- `transcribe` (`:142-160`): `provider.transcribe` returns `durationSeconds` (OpenAI `verbose_json.duration`; the local runner knows it; recorded-voice routes already have `Attachment.durationMs`, pass it in `TranscriptionInput.durationMs` as the fallback). Usage = `{audioSeconds}`.
- `transcribeStream` (`:171-227`): count PCM bytes pushed since the last `final` (24 kHz × 16-bit mono = 48 000 B/s) and record `audioSeconds` per utterance; on fatal error record the partial seconds with `estimated: true`.
- `speak` (`:304-338`): usage = `{ttsCharacters: input.text.length}`; keep billing at acceptance (the comment's reasoning stands).
- `chat` (`:78-96`): track `firstTokenMs` on the first `text` event and accumulate yielded characters; in `finally`, if no `done` arrived and status is still `ok`, record `status: "ok"`, `estimated: true`, `inputTokens: estimateTokens(system+messages)`, `outputTokens: ceil(chars/4)`. Budget guard stays conservative; the statement marks estimated rows.
- Budget estimate for `transcribe`/`transcribeStream` is `0` today (`:147`, `:184`): use `audioPerMinute × expected minutes` (attachment duration, or 1 minute for a stream open).

### 4.3 Grouping and budget lines (`apps/api/src/modules/stats/routes.ts`)

- `/spend?groupBy=` adds `provider` (select `providerId`, join name) and `status`; rows add `audioSeconds, ttsCharacters, estimatedCents`.
- New `GET /spend/budgets` → every `Budget` row for the tenant with `name` (campaign/session lookup), `limitCents`, `spentCents` (via `PrismaLedger.spentCents`, `packages/core/src/providers/prisma-sources.ts:103-123`), `fraction`, `state: ok|warning|blocked`. The dashboard's budget panel renders this list instead of the tenant line alone (`components/admin/SpendPanel.tsx`).
- `/stats.ai.month` adds `firstTokenP95Ms`, `firstTokenP50Ms` (raw `percentile_cont` on `LlmCall.firstTokenMs` where purpose in the chatty set), `audioMinutes`, `ttsCharacters`, `voice: { sessions, firstWordP95Ms, interruptionsPerSession, streamFallbacks }` from `SessionEvent type='voice.live'` (and from the histogram once per-utterance events exist).

### 4.4 Statement = the data invoicing reads

New table `TenantStatement` (`companyId, month (yyyy-mm) @@unique, generatedAt, currency, lines Json, totals Json, counts Json`). Monthly job `billing.statement` (cron `17 2 1 * *`, UTC; also runnable from the jobs page) runs per tenant inside `withTenant` and freezes:

- `lines[]`: `{providerId, providerName, model, purpose, calls, inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, audioSeconds, ttsCharacters, costCents, estimatedCents}`
- `counts`: sessions started / completed, participants, live-voice minutes, storage bytes at month end, campaigns active, analyses run, spec versions generated
- `totals`: `costCents`, by purpose, by provider; the budget line(s) in force and whether any were hit, with dates.

Routes: `GET /spend/statements` (list), `GET /spend/statements/:month?format=json|csv` for the tenant; `GET /operator/statements/:month?format=csv` streams every tenant's lines (one CSV, `companyId` column) for the operator's invoicing spreadsheet. Freezing matters because `privacy.delete-session` keeps `LlmCall` rows but retention may later purge them; the statement survives. `PrismaLedger` gets `statementFor(companyId, month)`; `InMemoryLedger` gets the same so the test is pure.

---

## 5. Backups and recovery

### 5.1 One backup image instead of a script in the Postgres image

`deploy/backup.Dockerfile`: `FROM pgvector/pgvector:pg16` + `apt-get install -y age rclone jq` (both in Debian bookworm). Built as `aidp-backup` by the `backup` service's `build:` (the only service that builds it; the restore-drill one-shot reuses it). This is what makes encryption, offsite and the drill live in one container with `pg_dump` matching the server major, as today.

### 5.2 Encryption at rest

`age` with a recipient. `generate-env.sh` runs `docker run --rm aidp-backup age-keygen` (or `age-keygen` on the laptop if present) and writes `BACKUP_AGE_RECIPIENT=age1…` and `BACKUP_AGE_IDENTITY=AGE-SECRET-KEY-…` into `deploy/.env`. Dumps become `ai_discovery-<stamp>.dump.age`, archives `uploads-<stamp>.tar.gz.age`, written through `pg_dump … | age -r "$BACKUP_AGE_RECIPIENT" > file.part` (never on disk in clear). `restore.sh` and the drill decrypt with `age -d -i <(printf %s "$BACKUP_AGE_IDENTITY")`. The identity on the box does not weaken the on-box posture (whoever reads `deploy/.env` has `POSTGRES_PASSWORD`); it is the offsite copy that needs it, and the private key is the second thing (after `PLATFORM_ENCRYPTION_KEY`) the operator stores off-box, which `DEPLOY.md` and the go-live checklist say in one sentence: "`deploy/.env` is the key to both backups and provider keys; copy it to your password manager now."

### 5.3 Offsite copy, gated on `RCLONE_REMOTE`

`backup.sh` after a successful local run: if `RCLONE_REMOTE` is set (e.g. `s3:aidp-backups` or `b2:…`), with `RCLONE_CONFIG_*` env variables (rclone reads its config from env, so no config file to mount), `rclone copy "$file" "$RCLONE_REMOTE/daily/"`, and on Sundays also `…/weekly/`, on the 1st also `…/monthly/`, then prune `daily` > 30 d, `weekly` > 90 d, `monthly` > 400 d with `rclone delete --min-age`. Failure writes `backup.json.offsite = failed` and an alert file (`backup.offsite_failed`). `generate-env.sh` writes the commented block; `DEPLOY.md` has one paragraph per provider (Hetzner Object Storage, Scaleway, Backblaze) with the three env lines each. Unset means "not configured" and the go-live checklist item stays red in `/operator/health`.

### 5.4 Retention policy (one table in OPERATIONS.md)

Local: `BACKUP_RETENTION_DAYS=14` daily (as today). Offsite: 30 daily, 13 weekly, 13 monthly. Logs: 10 MB × 3 per container (as today). Statements: forever. Ledger rows: with the session retention (24 months default), statement rows carry the invoicing truth after that.

### 5.5 Weekly automated scratch restore with assertion

`backup.sh` writes a manifest at dump time into `backup.json.counts`: `select count(*)` for `Company, User, Campaign, Session, Message, Fact, Attachment, LlmCall` (one query, pg-side). `deploy/restore-drill.sh` (in the backup image, run Sundays at `BACKUP_DRILL_AT`, default 04:40, by the same scheduler loop) does: pick the latest dump → decrypt → `createdb ai_discovery_drill` → `pg_restore --no-owner --role=app` → run the same count query → every table must be `>= manifest - 0` (equal; the dump is a snapshot) → `pg_restore` of the uploads archive into a temp dir and `tar -tzf` count must equal manifest `uploadsCount` → `dropdb ai_discovery_drill` → write `backup.json.drill = {at, result, durationS, dump}` → on any failure write `/ops-state/alerts/backup.drill_failed-<ts>.json`. Memory: the drill runs `pg_restore` inside the backup container (512 MB is enough for the dump sizes a pilot produces; the restore load lands on Postgres, at 04:40). Measured drill duration becomes the RTO evidence and shows on the Host dashboard.

### 5.6 Backup failure flips the healthcheck

```yaml
healthcheck:
  test: ["CMD-SHELL", "/usr/local/bin/backup-health.sh"] # reads /ops-state/status/backup.json:
  #  exit 1 if lastResult != ok, or lastSuccessAt older than BACKUP_MAX_AGE_HOURS (26), or scheduler heartbeat > 300 s
```

Unhealthy is visible in `dc ps`, in `/operator/health`, and the sweep raises `backup.failed`/`backup.missing`; the sidecar raises them too if the worker is down.

### 5.7 Models volume: decision

Do not back it up. It is a cache of a pinned Hugging Face model id (`onnx-community/whisper-small`, about 250 MB) that the API re-downloads on first use in one to two minutes; the ledger, the routes and the transcripts are in Postgres. Record as a decision row; the RTO below includes the re-download. The one caveat goes in OPERATIONS.md: a restore onto a host without egress to Hugging Face falls back to the "try again in a minute" path for recordings until the download succeeds; route `transcription` to OpenAI if that matters on the day.

### 5.8 RPO / RTO (documented in OPERATIONS.md, with the evidence rows the drills fill in)

|                                         | Target                                                                                       | How                                                                                                                                                                |
| --------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| RPO                                     | 24 h (nightly), optionally 12 h by setting `BACKUP_AT=03:20,15:20` (the loop accepts a list) | pg_dump + uploads archive, encrypted, offsite                                                                                                                      |
| RTO, same host, bad release or bad data | 15 min                                                                                       | `deploy/rollback.sh` (6.1) then `restore.sh --latest --force`; measured 5 s on an empty DB, minutes on real data                                                   |
| RTO, dead host                          | 90 min                                                                                       | new VPS → `git clone` → restore `deploy/.env` from password manager → `docker login`/pull or build → `rclone copy` latest pair → `restore.sh <file> --force` → DNS |
| Verification                            | weekly, automatic                                                                            | 5.5                                                                                                                                                                |

---

## 6. Release engineering

### 6.1 SHA-tagged images, rebuild-free rollback

- `deploy/compose.prod.yml`: `name: ${COMPOSE_PROJECT_NAME:-aidp}`; images `${AIDP_REGISTRY:-}aidp-server:${AIDP_VERSION:?}` and `…aidp-web:${AIDP_VERSION:?}`; `pull_policy: ${AIDP_PULL_POLICY:-never}`. `generate-env.sh` writes `COMPOSE_PROJECT_NAME=aidp`; **existing installs must write `COMPOSE_PROJECT_NAME=deploy`** or their volumes (`deploy_pgdata`) are orphaned; `upgrade.sh` detects `deploy_pgdata` + project `aidp` and refuses with that sentence.
- `deploy/upgrade.sh [--to <ref>] [--pull]`: `git fetch`; show `CHANGELOG.md` diff between the running `AIDP_VERSION` and the target; `df` check (refuse under 3 GB free when building on-box); `dc exec -T backup backup.sh once` and wait for `backup.json.lastResult=ok` for that run (pre-upgrade backup is not optional); `AIDP_VERSION=$(git rev-parse --short=12 <ref>)`; build both images with that tag (or `docker pull` when `--pull`); write `AIDP_VERSION` and `AIDP_PREVIOUS_VERSION` into `deploy/versions.env` (second `--env-file`, so `deploy/.env` is never machine-edited); touch the maintenance flag (6.3); `dc up -d --remove-orphans`; wait for `migrate` exit 0 and `api`/`web` healthy within 5 min; smoke (`/api/v1/health/ready` 200 with `database:true`, `/auth/signin` 200 through Caddy, `/operator/jobs` reachable with the internal token); clear the flag; `docker image prune` keeping the last three `aidp-*` tags; print the version pair.
- `deploy/rollback.sh`: swaps `AIDP_VERSION`/`AIDP_PREVIOUS_VERSION` and `dc up -d`; no build, no network. If migrations ran, it prints the data-rollback instructions (6.2) and the dump it took before the upgrade.
- CI `.github/workflows/release.yml` (off-box option): on push to `main` and on `v*` tags, `docker/build-push-action` to `ghcr.io/<owner>/aidp-server:sha-<12>` and `:v<version>`, same for web; the VPS sets `AIDP_REGISTRY=ghcr.io/<owner>/` and `AIDP_PULL_POLICY=missing` and runs `upgrade.sh --pull`. Recommended on 4 GB hosts: an on-box `pnpm install` + `tsc` + `next build` alongside a running stack is the single most likely way to OOM the pilot.

### 6.2 Migrate failed mid-upgrade: the state and the recovery

What the stack looks like: `migrate` exited non-zero; compose stopped before recreating `api`/`worker`/`web` (they depend on `preflight` → `migrate` success), so the _old_ containers are still serving against a schema that is at migration boundary k of n (Prisma applies each migration file in its own transaction; `_prisma_migrations` has a row with `finished_at IS NULL` and `logs` filled for the failed one). Three cases, in OPERATIONS.md under `### migrate.failed`:

1. Transient (Postgres restarting, lock timeout): `dc up -d migrate` re-runs; Prisma resumes at the failed migration.
2. The migration itself is wrong: fix forward in a new commit; before re-running, `prisma migrate resolve --rolled-back <name>` from the `migrate` container (and undo any partial DDL by hand if the migration was non-transactional); then `upgrade.sh` again.
3. Old code cannot live with the applied migrations: `rollback.sh` then `restore.sh <pre-upgrade dump> --force`. `upgrade.sh` printed the dump name.

Policy that makes case 3 rare: expand/contract. A migration in release N only adds (columns nullable or defaulted, tables, indexes); the drop or rename ships in N+1 after the code stopped reading the old shape. Add it to AGENTS.md conventions and check it in review; a CI step `scripts/check-migration-additive.sh` greps new migration SQL for `DROP|ALTER COLUMN .* TYPE|RENAME` and requires a `-- contract:` marker line to pass.

### 6.3 Staged rollout on one VPS: recommendation

Not blue-green. It doubles `api`+`web` memory (~3.3 GB of limits) for a few seconds of downtime, and the schema is shared anyway, so the dangerous half of a release (migrations) gains nothing. What to do instead, all in `upgrade.sh`:

- Maintenance page: Caddy `@maint file /maintenance/on` → `respond "…back in a minute" 503` with `Retry-After: 30`; `upgrade.sh` creates/removes the file in a tiny `caddy_maint` volume. Participants see a page, not a proxy error, during the ~10 s window.
- Gates before and after (backup, health, smoke) with automatic `rollback.sh` if the post-gate fails.
- "Staging" is the laptop or CI running `deploy/compose.loadtest.yml` (8.2) with the fake provider; a tag only gets `upgrade.sh`'d after `pnpm check` and the k6 thresholds pass in CI.
- Revisit blue-green for `web` only (stateless, 768 MB) if an 8 GB host and a pilot with live voice at hour-long sessions make the 10 s matter.

### 6.4 Release notes, `since`, the "what changed" panel, CHANGELOG policy

- `docs/CHANGELOG.md` in Keep-a-Changelog form; every PR adds a line under `Unreleased` (CI `scripts/check-changelog.sh` fails a PR that touches `apps/` or `packages/` without one). `scripts/release.sh <version>` moves `Unreleased` to `## [<version>] - <date>`, generates the "Decisions" subsection from `docs/discovery/decisions.md` rows whose Date is after the previous release, and the "New settings" subsection from catalog entries with `since: "<version>"`, commits, tags `v<version>`.
- `SettingDef` gains `since?: string` (semver of the release that introduced the key); the catalog test asserts every key added after this change has it.
- `packages/shared/src/release-notes.ts`: `RELEASES: { version, date, highlights: string[], decisions: string[], newSettings: SettingKey[] }[]`, maintained by `release.sh` (it appends the entry it just generated). `GET /settings/whats-new` returns entries newer than `User.lastSeenRelease` (new column); `apps/web/src/components/admin/WhatsNew.tsx` panel on the admin landing page, dismiss sets the column. This is the phase-plan footer's promise, made true from data.

---

## 7. Self-serve tenancy operations

### 7.1 Today vs missing (`apps/api/src/modules/operator/routes.ts`)

|                      | Exists                                                                                                                                            | Missing                                                                                                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create tenant        | `POST /operator/tenants` creates `Company`, admin `User`, tenant `Budget`, audits                                                                 | no invitation email (the admin must guess to visit `/auth/signin`); no welcome content; no onboarding checklist; `region` is free text; no per-tenant limits; `monthlyBudgetCents` is duplicated on `Company` and `Budget`    |
| Suspend              | `PATCH /operator/tenants/:id {status}`; UI toggle in `TenantsPanel.tsx:96-103`; staff tokens refused for non-active companies (`principal.ts:48`) | participant links and tokens still work; jobs still run and spend; Auth.js still mints a web session (the API refuses afterwards, so the admin sees errors rather than "suspended"); no confirmation dialog; no reason/notice |
| Stats                | `GET /operator/stats`: tenant count, sessions by status, spend by tenant                                                                          | nothing per-tenant about health or limits                                                                                                                                                                                     |
| Export / offboarding | nothing                                                                                                                                           |                                                                                                                                                                                                                               |

### 7.2 Creation with an invited first admin

`POST /operator/tenants` publishes `email.send` to `adminEmail` with a rendered invitation (subject "You have been made admin of <tenant> on <productName>", body with the sign-in URL and the three first steps: add users, add a provider or ask the operator for a platform route, create a campaign), audited as `tenant.invite_admin`. Add `Company.onboarding Json` holding the checklist state the operator UI renders (7.6). Replace `region` free text with `z.enum(["eu"])` for now (spec 07 lists region as an operator field; adding a second region is a data-residency decision, not a string).

### 7.3 Suspension enforcement (all sites raise `AppError("tenant_suspended")` → 403 with a translated page)

- `apps/api/src/auth/principal.ts:56-70` (participant branch): include `sessions.company.status` and return anonymous when not active.
- `apps/api/src/modules/participant/service.ts:40-75` `resolveLink` and the invitation path `:81-90` of `routes.ts`: `view.status = "suspended"` → the web shows "This organisation's interviews are currently unavailable".
- `apps/worker/src/handlers.ts` `scoped()`: look up `Company.status` once per job and skip tenant jobs for suspended companies with a `job skipped: tenant suspended` log line (retention and deletion jobs still run; suspension is not a reason to keep data longer).
- `apps/web/src/auth` sign-in callback: a user whose company is suspended gets a "suspended" page instead of the admin shell (today the API refuses and the UI shows load errors).
- `PATCH /operator/tenants/:id` gets `reason` and the `TenantsPanel` toggle a confirmation dialog; suspension emails the tenant admins (`tenant.suspended` notification kind, info).

### 7.4 Per-tenant resource ceilings (settings, raisable only by the platform scope: `SettingDef.ceiling: true` means a tenant may set a lower value only; `SettingsService.set` enforces)

| Key                            | Default | Enforcement point                                                                                                                                                                                                      | On breach                                                                                                         |
| ------------------------------ | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `limits.storageBytes`          | 5 GiB   | `AttachmentService` before `storage.put` (`packages/core/src/attachments/service.ts`), using a `Company.storageBytesUsed` counter updated on put/delete (and recomputed by the sweep from `sum(Attachment.sizeBytes)`) | 413 `limit_exceeded`, participant sees "attachments are full for this organisation"; alert `tenant.limit_reached` |
| `limits.sessionsPerMonth`      | 500     | session creation in `participant/service.ts` (`start` for links and invitations): `count(Session where companyId, createdAt >= monthStart)`                                                                            | link page shows "closed" with that reason; alert                                                                  |
| `limits.voiceMinutesPerMonth`  | 300     | `voice-live.ts` on open (sum of month's `LlmCall.audioSeconds` for `stt_stream                                                                                                                                         | transcription                                                                                                     | realtime_voice` purposes) and every 60 s during the call | `unavailable { reason: "limit", fallback: "text" }` (D-72 chain) ; alert |
| `limits.attachmentsPerSession` | 10      | attachment create                                                                                                                                                                                                      | 409                                                                                                               |
| `limits.campaignsOpen`         | 20      | campaign open                                                                                                                                                                                                          | 409                                                                                                               |

Numbers show in `/stats` (tenant) and `/operator/tenants` (utilisation columns).

### 7.5 Export and offboarding jobs

- `tenant.export` (`{companyId, requestedBy}`): inside `withTenant`, stream every scoped model to JSON lines (`packages/db/src/tenancy.ts` already knows the scoped model list), plus settings at tenant/template/campaign scopes, plus `uploads` under `companyPrefix(companyId)`, into a zip via `packages/core/src/requirements/zip.ts` streaming variant, stored at `exports/<companyId>/<stamp>.zip` in the `StoragePort`; audits `tenant.export`; emails tenant admins a 7-day signed URL (`GET /exports/:token`). Also callable by the tenant admin (`POST /privacy/export`) which covers spec 11's export promise.
- `tenant.offboard` (`{companyId, confirmName}`): operator-only, requires typing the tenant name (UI) and `status: suspended` first; steps: export (above) → wait 7 days unless `--now` (grace flag in payload) → delete rows for the company in dependency order through `tenantTransaction` → `storage.deletePrefix(companyPrefix)` → keep `Company` as `status: "deleted"`, `TenantStatement` rows, `AuditLog` rows and `LlmCall` aggregates (invoicing) → audit `tenant.offboard` → alert operator `tenant.offboarded` (info). Test: after the job, `count(*)` per scoped table for the company is 0 and `storage.head` of a known key is null.

### 7.6 Operator stats to run ten tenants on one box

`GET /operator/health` (new) and an extended `GET /operator/tenants` row:

- Per tenant: sessions this month (vs `limits.sessionsPerMonth`), active sessions now, spend MTD vs budget (fraction), storage bytes (vs limit), voice minutes (vs limit), last activity at, open campaigns, jobs dead-lettered last 24 h for this tenant, suspended/active, onboarding checklist completion.
- Platform: queue depth and dead letters, worker heartbeat age, API p95 first token (24 h) and error rate (1 h), provider error rates (1 h), disk used ratio, backup age and last drill result, offsite configured (yes/no), TLS days left, speech model state, memory per service (from `docker stats` is not reachable from inside; use process RSS from `process.memoryUsage()` reported by api and worker and leave Postgres to the dashboard), version (`AIDP_VERSION` env exposed as `version` in `/health/ready` and here).

UI: `admin/operator/stats/page.tsx` becomes two tabs, "Platform health" (traffic lights, each linking to the OPERATIONS.md anchor) and "Tenants" (table with utilisation bars). This is the page the operator opens every morning; the go-live checklist items become rows on it, so the checklist is live state, not prose.

---

## 8. Capacity and resilience

### 8.1 Right-sizing (limits become variables in `compose.prod.yml`; presets in `deploy/sizes/4gb.env` and `8gb.env`, selected by `generate-env.sh --size 4gb|8gb` which appends the chosen file's lines)

| Service                  | 4 GB host                                                                                                                                         | 8 GB host                                            | Notes                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------ |
| postgres                 | 768M, `shared_buffers=192MB`, `max_connections=60`                                                                                                | 1536M, `shared_buffers=512MB`, `max_connections=100` | api+worker pools ≤ 2×(5+5) by default                                          |
| api                      | 1024M (`SPEECH_MODEL_IDLE_MINUTES` irrelevant: 4 GB preset routes `transcription` to OpenAI; local Whisper refused by `/operator/health` warning) | 2560M (local whisper-small)                          | the 4 GB preset sets `LOCAL_SPEECH_ENABLED=false` so the model is never loaded |
| worker                   | 512M                                                                                                                                              | 1024M                                                | `WORKER_CONCURRENCY=2` on 4 GB                                                 |
| web                      | 512M                                                                                                                                              | 768M                                                 |                                                                                |
| caddy                    | 128M                                                                                                                                              | 256M                                                 |                                                                                |
| backup                   | 256M                                                                                                                                              | 512M                                                 | drill needs headroom for `pg_restore`                                          |
| ops-notify               | 32M                                                                                                                                               | 32M                                                  |                                                                                |
| observability (optional) | not recommended                                                                                                                                   | 256+384+256 = 896M                                   |                                                                                |
| **Sum of limits**        | **3232M**                                                                                                                                         | **7584M**                                            | OS + Docker ~500M                                                              |

Limits are ceilings, not reservations; the point is that worst-case cannot exceed RAM. Also add `memory.reservation` lines so compose's scheduler (and a human) sees the expected floor, and `oom_kill_disable: false` explicitly. Build on-box only on 8 GB; 4 GB uses `--pull`.

### 8.2 Load test (k6)

- `tools/fake-provider/` : the `fakeModelServer` from `apps/api/test/helpers.ts:56-140` extracted into a runnable package (`Dockerfile`, 64 MB) with env knobs `LATENCY_MS=400 JITTER_MS=300 FAIL_RATE=0 HANG_RATE=0 STREAM_CHARS_PER_S=60 REALTIME_FIRST_PARTIAL_MS=300`. Tests keep importing it.
- `deploy/compose.loadtest.yml`: dev compose + `fake-provider` service; bootstrap env `FAKE_PROVIDER_URL` so `bootstrap` seeds an `openai_compatible` platform provider routed for every purpose, one campaign with `verification=open` and a share link written to `/ops-state/loadtest/link`.
- `load/k6/interview.js`: scenarios `participants` (ramping-vus 0→40 over 2 min, hold 10 min, ramp down 1 min; each VU: `GET /p/:link`, `POST /p/:link/start`, consent, then 12 turns of `POST /p/session/turn` reading the SSE body and recording `first_token_ms` on the first `event: text` and `turn_ms` at `event: turn`; `think` 3–8 s) and `voice` (5 constant VUs with k6 `ws`: connect `/api/v1/p/session/live`, send 60 s of 24 kHz PCM from `load/fixtures/utterance.pcm` at real-time pace in 100 ms frames, record `first_partial_ms` (speech_started→first caption) and `first_word_ms` (speech_stopped→first audio frame), one barge-in per minute). Thresholds: `first_token_ms p(95) < 2000`, `first_word_ms p(95) < 1500`, `http_req_failed < 1%`, `ws_session_errors == 0`, and after the run `GET /operator/jobs` must show `queued == 0` within 120 s (drain check in `teardown`). Output JSON is kept as a CI artefact; `pnpm load:test` runs it locally with the fake at 400 ms, so it measures regressions in the API/engine, not provider speed. A one-off capacity run on a scratch VPS of the production size before the pilot is documented in OPERATIONS.md ("Capacity test").

### 8.3 Chaos checklist (each row: expected behaviour, how it is tested, what alerts)

| Fault                                       | Expected                                                                                                                                                                                                                                                            | Test                                                                                                                                                                                                              | Alert                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Provider returns 5xx/429                    | turn ends with `error { code: provider_error }`, answer saved, session stays `active`; after `ops.providerErrorRateWarn` the circuit opens and the fallback route (8.4) takes over; the interview continues                                                         | `apps/api/test/chaos-provider.e2e.test.ts` with `FAIL_RATE=1` on the fake; asserts message saved, status active, `MemoryAlerts` has `provider.circuit_open`, next turn served by fallback provider                | `provider.error_rate`, `provider.circuit_open`                          |
| Provider hangs                              | `AbortSignal` fires at `connectMs`/`firstTokenMs`/`totalMs`; turn lock released in `finally`; the same participant can retry within seconds, not 120 s                                                                                                              | fake with `HANG_RATE=1`; asserts timing < `totalMs + 1 s` and lock cleared                                                                                                                                        | as above after threshold                                                |
| Postgres restart                            | API readiness 503 for ~10 s then 200; pg-boss `error` events logged, consumers resume; no job lost (pg-boss is in Postgres); in-flight turns fail with `internal` and the answer the participant typed is re-sent by the client (it already keeps the draft)        | `deploy/chaos/postgres-restart.sh` (`dc restart postgres`, poll `/health/ready`, publish a job, assert it completes)                                                                                              | `api.down` only if > 5 min                                              |
| Disk full                                   | backup fails (`.part` removed, `backup.json` failed, healthcheck red); Postgres refuses writes → 500s; API keeps serving reads                                                                                                                                      | `deploy/chaos/disk-full.sh` runs the backup container with `--tmpfs /backups:size=1m` and asserts the alert file exists; the Postgres half is documented, not automated                                           | `backup.failed`, `disk.high` (should have fired first)                  |
| Worker killed mid-job                       | job returns to `retry` after `expireInSeconds`; handlers are idempotent (`session.summarize/extract` record their seq; `analysis.run` per id; make `session.extract` write facts in the same transaction as `lastExtractedSeq`, the status report's data-loss path) | `apps/worker/test/handlers-idempotent.test.ts` runs each handler twice over in-memory fakes and asserts single effects; `deploy/chaos/kill-worker.sh` kills during `analysis.run` and asserts one `done` analysis | `job.stuck` if maintenance also died; `job.dead_lettered` after retries |
| Caddy cert renewal blocked (port 80 closed) | renewal fails 30 days out; alert at 14                                                                                                                                                                                                                              | `ops-notify` unit: feed a fake `expire date` line                                                                                                                                                                 | `tls.renewal`                                                           |
| Backup never ran (clock, crash)             | `backup.missing` at 26 h; healthcheck red                                                                                                                                                                                                                           | sweep test with old `backup.json`                                                                                                                                                                                 | `backup.missing`                                                        |

### 8.4 Timeouts, circuit breaking, and what to do with `downgrade`

- `packages/ai/src/providers/resilience.ts`: `deadline({ connectMs: 10_000, firstTokenMs: 20_000, totalMs: 120_000 })` returning an `AbortSignal` that the OpenAI-compatible adapter passes to every `fetch` (today only `speak` takes a signal, `openai-compatible.ts:284`), and that `anthropic.ts:45` sets as `timeout` on the SDK client with `maxRetries: 0` (one retry policy, ours). Values are a platform setting group `providers.timeouts.*` so a slow self-hosted LiteLLM can be accommodated without a release. Streams: the first-token deadline is cleared on the first chunk; an idle gap > 30 s mid-stream aborts.
- Circuit breaker per `providerId` inside `ProviderRegistry` (`packages/ai/src/providers/registry.ts`): open after 5 failures in 60 s (timeouts, 5xx, 429), stays open 30 s, half-open lets one call through. State is per process; the alert makes it visible.
- Fallback route: `Route` gets a sibling row `tier: "fallback"` (`@@unique([companyId, purpose, tier])`); admin UI shows a second model picker per purpose. `ModelCaller.prepare` uses it when the primary's circuit is open or the primary throws a retryable `ProviderError`, records `ledger.routeTier = "fallback"`, and raises `provider.fallback_active` (info, deduped per provider per hour).
- **Recommendation: remove `downgrade` from `cost.onBudgetExceeded`** (schema becomes `z.literal("pause")` and the key is kept one release for compatibility, then dropped; decision row). A budget is a promise about money; "never silent" (spec 08) is now met by `budget.warning` at 80/90% and `budget.exceeded` with pause, both to the tenant admin. Spending on a cheaper model after the tenant's limit is still spending the tenant did not authorise, and the only honest version (a second, lower "soft" budget) is a budget line the admin can already create today. The fallback-route machinery that `downgrade` would have needed is built anyway for outages, where it buys availability instead of taking liberties with someone's money. Spec 07/08 text changes through decisions.md.

---

## 9. Documentation

### 9.1 Structure

| File                              | Purpose                     | Moves in                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Moves out                                                                                                                                            |
| --------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/DEPLOY.md`                  | install and configure, once | sizing presets, off-box images, offsite env blocks, alert env, `COMPOSE_PROJECT_NAME` note                                                                                                                                                                                                                                                                                                                                                                                                                | backups detail, restore, upgrade, rollback, logs, disk, "before you go live" (becomes the live checklist on `/operator/health` plus a short pointer) |
| `docs/OPERATIONS.md` (new)        | run it; the 3 a.m. page     | cadence (daily: glance at `/operator/health`; weekly: drill result; monthly: statements, `pnpm audit`, host updates); **Alert runbook**: one `### <kind>` section per `AlertKind` with Symptom / Where to look (exact `dc` commands and dashboard panel) / What to do / How you know it is fixed; backups, restore, drill; upgrade, rollback, `migrate.failed`; jobs admin; capacity test; chaos scripts; tenant onboarding and offboarding checklists; what is never logged; RPO/RTO; drills log pointer |                                                                                                                                                      |
| `docs/RUNNING.md`                 | development only            | keep; link to DEPLOY.md for provider/voice configuration instead of restating it                                                                                                                                                                                                                                                                                                                                                                                                                          | the duplicated provider/voice paragraphs                                                                                                             |
| `docs/team/drills/<date>-<restore | chaos>.md`                  | the owner's recorded drills (10)                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |                                                                                                                                                      |     |
| `infra/observability/README.md`   | the optional stack          |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |                                                                                                                                                      |
| `docs/CHANGELOG.md`               | 6.4                         |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |                                                                                                                                                      |

### 9.2 Drift to fix (from the status report and this read)

1. `DEPLOY.md` "Model configuration": purposes `summarize`, `analysis`, `report` do not exist; the list is `interview_turn, resume_summary, extraction, clustering, analysis_report, spec_turn, issue_detection, spec_generation, transcription, stt_stream, tts, realtime_voice, file_ingest, vision_ingest, embedding` (`packages/shared/src/purposes.ts`).
2. `DEPLOY.md` "What this deliberately does not cover → Object storage": stale; uploads are a volume, backed up with the dump; MinIO is a dev extra for the `StoragePort` S3 adapter.
3. Same section, "Monitoring and alerting" and "Offsite backups": rewrite after M1.
4. `DEPLOY.md` "Database roles": says thirteen tables, preflight prints 15 and the check is now a query, not a count.
5. `DEPLOY.md` images sentence ("Four images for nine services") after `aidp-backup` and `ops-notify`.
6. `DEPLOY.md`: web image build needs egress to Google Fonts (Next font download at build).
7. `apps/api/.env.example`: add `OPENAI_BASE_URL`, `MODEL_CACHE_DIR`, `SPEECH_MODEL_IDLE_MINUTES`, `METRICS_PORT`, `ALERT_*`.
8. `deploy/compose.prod.yml` worker: `OTEL_EXPORTER_OTLP_ENDPOINT` is passed but unread (fixed by 3.1).
9. `docs/spec/12-operations.md` and `10-architecture.md`: `infra/` now exists (3.6); Kroki/MinIO stay in the dev compose, say so.
10. `evals/README.md`: `pnpm eval:live` does not exist; either add the script stub that exits with "not implemented, see Tier 5" or reword.
11. `docs/spec/15-phase-plan.md` footer ("release notes, what-changed panel, migration reversible"): true after 6.2/6.4, with "reversible" restated as expand/contract plus pre-upgrade dump.
12. `docs/spec/07`, `08`: `downgrade` removed per 8.4; `19-admin-configuration.md` gains `ops.*`, `notifications.*`, `limits.*`.
13. Status report finding 9 ("nothing checks suspension"): staff path is enforced at the API; update the finding when 7.3 lands.
14. `backup` healthcheck description in `DEPLOY.md` (currently implies success).

### 9.3 Operator checklist: onboarding a tenant (in OPERATIONS.md and mirrored as `Company.onboarding` rows on `/operator/tenants/:id`)

1. Create the tenant with the admin's address and budget (default from `cost.defaultMonthlyBudgetCents`); confirm the invitation email arrived (audit `tenant.invite_admin`).
2. Decide provider ownership: platform routes (tenant spends under your keys, your budget line) or tenant-owned providers (they add keys in Admin → Providers). Record it in the tenant's notes field.
3. Set limits if not default: `limits.storageBytes`, `limits.sessionsPerMonth`, `limits.voiceMinutesPerMonth`.
4. Decide voice: `features.realtimeVoice` off by default; if on, `transcription`/`tts`/`stt_stream` routes exist and the first live call was held on a phone.
5. Privacy: `privacy.retentionMonths`, `privacy.kAnonymity`, `privacy.rawTranscriptsVisibleTo` agreed with the tenant and set.
6. Email: tenant SMTP (`email.smtpUrl`) or platform relay; `POST /settings/email/test` sent to the admin.
7. Branding: `branding.productName`, `branding.primaryColor`; consent text reviewed by the tenant.
8. Notifications: `notifications.recipients` set; a `budget.warning` test fired from the admin page ("Send test notification" button, M3).
9. The tenant admin ran one interview end to end on the shipped template and saw the summary.
10. Statement: the tenant appears in `/operator/statements/<month>` after the first calls.
11. Spend check after week one: `/spend/budgets` fractions, `firstTokenP95Ms`, dead letters zero.
12. Offboarding terms (export + 7-day grace) acknowledged in the contract; the operator knows `tenant.offboard` exists.

---

## 10. Milestone plan

Effort in working days for one engineer or agent, including tests and docs. Each milestone ends with `pnpm check` green with `DATABASE_URL`, and a decisions.md row per design choice (AlertPort and table; ops-notify sidecar; `downgrade` removal and fallback tier; backup image + age + rclone; models volume not backed up; SHA tags and `COMPOSE_PROJECT_NAME`; expand/contract; no blue-green; Prometheus pull; tenant ceilings as `ceiling` settings).

### M1 — Pilot-safe (8–9 days). "Every failure reaches a human, no job is lost or doubled, the box can be rolled back."

| #   | Work                                                                                                                                                  | Files                                                                                                    | Days | Depends on |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---- | ---------- |
| 1   | AlertPort, router, email + webhook channels, `MemoryAlerts`, `OpsAlert` table + RLS policy + migration, settings keys, audit rows                     | `packages/core/src/alerts/*`, `packages/shared/src/settings.ts`, `packages/db/prisma/*`                  | 1.5  |            |
| 2   | Wire budget warn/exceeded (`onBudgetExceeded` hook, `CallerFactory`), participant strings, remove `downgrade`                                         | `callModel.ts`, `caller-factory.ts`, `context.ts`, `worker/main.ts`, `turn-runner.ts`, settings          | 1    | 1          |
| 3   | Dead-letter alert, `expireInSeconds`, `BossJobs.inspect`, `/operator/jobs` + dead list + retry/discard + run-now, jobs UI page                        | `jobs/definitions.ts`, `pg-boss.ts`, `jobs/admin.ts`, `operator/jobs.ts`, `admin/operator/jobs/page.tsx` | 1.5  | 1          |
| 4   | `ops.health-sweep` job (stuck, dead, backup.json, disk, provider error rate) + `ops_state` volume                                                     | `core/src/ops/health-sweep.ts`, `handlers.ts`, compose                                                   | 1    | 1, 3       |
| 5   | Worker heartbeat + self-exit + healthcheck; `ops-notify` sidecar (watchdog, preflight alert file, TLS check, SMTP via curl)                           | `worker/heartbeat.ts`, `deploy/ops/notify.sh`, `preflight.sh`, compose                                   | 1    | 1          |
| 6   | Outbound timeouts (`resilience.ts`, both adapters)                                                                                                    | `packages/ai/src/providers/*`                                                                            | 0.5  |            |
| 7   | Suspension for participants, jobs, web sign-in; confirmation dialog                                                                                   | `principal.ts`, `participant/service.ts`, `handlers.ts`, web                                             | 0.5  |            |
| 8   | `aidp-backup` image: age encryption, `backup.json` with manifest counts, health script, rclone offsite gated on `RCLONE_REMOTE`; `restore.sh` decrypt | `deploy/backup.Dockerfile`, `backup.sh`, `restore.sh`, `generate-env.sh`, compose                        | 1    |            |
| 9   | SHA tags, `COMPOSE_PROJECT_NAME`, `versions.env`, `upgrade.sh` with pre-upgrade backup and gates, `rollback.sh`, maintenance flag in Caddy            | `deploy/*`                                                                                               | 1    | 8          |
| 10  | `OPERATIONS.md` v1 (alert runbook for every kind, restore, upgrade, `migrate.failed`), DEPLOY drift items 1–8, 14                                     | docs                                                                                                     | 1    | all        |

Acceptance: with the fake provider stack, each of the eleven alert kinds can be provoked by a test or a chaos script and appears in `MemoryAlerts`/the webhook within 5 minutes; a dead-lettered job is retried from the UI; `upgrade.sh` then `rollback.sh` on a laptop stack completes without a rebuild; the backup container goes unhealthy when `pg_dump` is made to fail; the preflight failure produces a webhook message.

### M2 — Observable and recoverable (9–10 days). "You can see p95, follow one session through API and worker, and prove a backup restores every week without touching it."

| #   | Work                                                                                                                   | Files                                                                                     | Days | Depends on |
| --- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---- | ---------- |
| 11  | Shared `startTelemetry`, worker tracing, `traceparent` in payloads, custom spans                                       | `core/src/telemetry/otel.ts`, `jobs/*`, `callModel.ts`, `turn-runner.ts`, `voice-live.ts` | 1.5  |            |
| 12  | Child loggers (auth plugin, jobs), `Logger.child`, redaction module + tests, Caddy log filters, eslint rule            | `auth/plugin.ts`, `lib/logger.ts`, `telemetry/redaction.ts`, `Caddyfile`                  | 1    |            |
| 13  | Metrics port, prom-client, metrics servers, `firstTokenMs` in ledger, p95 and voice in `/stats` and `/operator/health` | `telemetry/metrics*.ts`, `callModel.ts`, `stats/routes.ts`, `operator/*`, migration       | 1.5  | 11         |
| 14  | `infra/observability` profile with provisioned dashboards and SLO panels                                               | `infra/observability/*`                                                                   | 1    | 13         |
| 15  | Weekly restore drill with row-count assertion and alert; RPO/RTO section with evidence table                           | `deploy/restore-drill.sh`, `backup.sh`, docs                                              | 1    | 8          |
| 16  | Ledger completeness: audio seconds, TTS chars, estimates, prices, provider grouping, `/spend/budgets`                  | `shared`, `ai/cost`, `callModel.ts`, `prisma-sources.ts`, `stats/routes.ts`, UI           | 1.5  |            |
| 17  | `TenantStatement` + `billing.statement` job + routes + CSV                                                             | `core/src/billing/*`, routes                                                              | 1    | 16         |
| 18  | CHANGELOG policy and CI check, `release.sh`, `since`, `RELEASES`, what's-new panel; CI image build to GHCR             | `scripts/*`, `.github/workflows/release.yml`, `settings.ts`, web                          | 1    | 9          |
| 19  | Sizing variables and presets, `generate-env.sh --size`; DEPLOY restructure; drift items 9–13                           | `deploy/*`, docs                                                                          | 0.5  |            |

Acceptance: a Grafana trace shows `session.turn → model.call` in the API and `job session.extract` in the worker under one trace id; `/stats.ai.month.firstTokenP95Ms` is non-null after one interview; no log line in the e2e capture contains a link token, an email or message text; the Sunday drill writes `drill.result=ok` and a forced mismatch produces `backup.drill_failed`; `/operator/statements/2026-10.csv` has one line per provider×model×purpose per tenant with audio seconds for a recorded answer.

### M3 — A-grade (9–10 days). "Ten tenants, self-serve, under load, through faults, with drills on record."

| #   | Work                                                                                                                        | Files                                                                                    | Days | Depends on |
| --- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---- | ---------- |
| 20  | Tenant creation invite, `Company.onboarding`, operator tenant page with checklist, `region` enum                            | `operator/routes.ts`, web                                                                | 1    | 1          |
| 21  | Ceilings as `ceiling` settings + five enforcement points + alerts + utilisation in stats                                    | settings, `attachments/service.ts`, `participant/service.ts`, `voice-live.ts`, campaigns | 1.5  | 1, 16      |
| 22  | `tenant.export`, `tenant.offboard`, `/privacy/export`, signed download route                                                | `core/src/tenancy/*`, `handlers.ts`, routes, UI                                          | 1.5  | 3          |
| 23  | `/operator/health`, tenants health table, go-live items as live state                                                       | `operator/*`, web                                                                        | 1    | 13         |
| 24  | Fake provider package + image, `compose.loadtest.yml`, k6 scenarios, CI job with thresholds                                 | `tools/fake-provider/*`, `load/k6/*`, workflow                                           | 1.5  |            |
| 25  | Circuit breaker, fallback route tier, admin picker, `provider.fallback_active`                                              | `ai/providers/registry.ts`, `callModel.ts`, `Route` migration, UI                        | 1.5  | 6          |
| 26  | Chaos scripts and tests (provider 5xx/hang, Postgres restart, disk full, worker kill); `session.extract` single transaction | `deploy/chaos/*`, api/worker tests, `handlers.ts`                                        | 1    | 24         |
| 27  | Owner drills performed and recorded; OPERATIONS.md final; decisions rows                                                    | `docs/team/drills/*`                                                                     | 1    | all        |

### What "operations A" means (the acceptance criteria for the whole program)

1. **No silent failure.** Every alert kind in `kinds.ts` has a provoking test or chaos script, a runbook section (enforced by the anchors test), and reaches the operator within 5 minutes; tenant admins receive only their own tenant's budget, completion and analysis notices.
2. **No lost or doubled work.** Every job has `expireInSeconds` and an idempotency test; dead letters are visible and retryable from the UI; a worker killed mid-job leaves one result.
3. **Recoverable, proven weekly.** RPO ≤ 24 h, encrypted offsite copy when `RCLONE_REMOTE` is set, automatic scratch restore with row-count assertion every week, `backup.failed`/`missing`/`drill_failed` alerts; the owner's manual restore drill from the _offsite_ copy onto a scratch host is recorded in `docs/team/drills/` with timings under the RTO targets (same host 15 min, new host 90 min).
4. **Rollback without rebuild.** `upgrade.sh`/`rollback.sh` demonstrated in the chaos drill: upgrade to a deliberately failing migration, observe `migrate.failed` handling, roll back, restore the pre-upgrade dump; total under 15 minutes, recorded.
5. **Measured, not averaged.** p95 first token and voice first word are visible in `/stats`, `/operator/health` and the dashboards; the k6 run passes `p(95) < 2000 ms` / `< 1500 ms` at 40 participants and 5 live voices against the fake stack in CI; a one-off capacity run on a production-sized host is recorded.
6. **Faults are rehearsed.** The chaos checklist (8.3) has a green run per row, recorded in `docs/team/drills/<date>-chaos.md`: provider down (interview continues on fallback, participant text is honest), Postgres restart, disk full, worker kill, cert check, missing backup.
7. **Ten tenants are a table, not a memory.** Creation sends the invite; suspension stops participants, staff and jobs; ceilings are settings with enforcement; offboarding leaves zero rows and bytes (test); `/operator/health` shows every tenant's utilisation and every platform signal on one page.
8. **The repository is the runbook.** Every operational behaviour in this program is a file: compose service, script, catalog key, migration, dashboard JSON, or OPERATIONS.md section with its anchor test. The only two things that live outside the box are `deploy/.env` (which now also holds the backup identity) and the offsite bucket credentials, and OPERATIONS.md says exactly that.
9. **Costs are complete.** Audio seconds, TTS characters and estimated rows are in the ledger; every budget line shows spend; the monthly statement exists per tenant and across tenants as CSV.
10. **Docs are true.** The fourteen drift items are fixed and `docs/team/status-<date>.md` after M3 re-grades operations with evidence links (drill files, CI runs, dashboard screenshots committed under `docs/team/drills/`).

Two drills the owner performs personally and records: a **restore drill** (criterion 3, from the offsite copy, onto a machine that is not the VPS) and a **chaos drill** (criteria 4 and 6, on the production VPS during a quiet hour, with the maintenance page up). Both templates (`docs/team/drills/TEMPLATE.md`: date, version, steps, timings, what surprised you, what changed in the repo afterwards) are part of M3.
