# 19 Admin configuration surface

Extends contracts 16, 17 and 18. Everything here is staff-facing and tenant-scoped unless it
says operator. Driven by D-31 ("show the numbers, hold the knobs"): every knob is a settings
key, and every configuration screen is generated from the catalog rather than hand-written.

## Secret settings

`SettingDef` gains `secret?: boolean`. A secret value is encrypted at rest with the platform
key (the same key that protects provider credentials) and never leaves the API in plain text.

- `GET /settings` returns the sentinel `"__unchanged__"` as the value of any secret that is
  set, and omits the key entirely when it is not. A parallel map `secrets: { [key]: boolean }`
  says which secret keys hold a value, so the UI can show "set" without showing the value.
- `PUT /settings` treats the sentinel as "leave as it is", any other string as a new value to
  encrypt, and `null` as "clear it".
- The audit diff records the key name and never the value.

## Email settings (new category `email`)

| Key             | Type   | Scopes           | Secret | Meaning                                                                               |
| --------------- | ------ | ---------------- | ------ | ------------------------------------------------------------------------------------- |
| `email.smtpUrl` | string | platform, tenant | yes    | connection string composed by the mail server form (D-410); empty logs to the console |
| `email.from`    | string | platform, tenant | no     | Envelope sender                                                                       |
| `email.replyTo` | string | platform, tenant | no     | Optional reply-to                                                                     |

The email port resolves its configuration per send, tenant first and platform second, falling
back to the deployment relay (`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY`, `SMTP_USER`,
`SMTP_PASSWORD`, D-445) and `EMAIL_FROM` from the environment when neither is set. A tenant
that sets its own SMTP sends its invitations from its own server. The API and the worker
resolve identically, so a message sent from a job looks the same as one sent from a request.

`GET /settings` also returns, for the platform and tenant scopes, an additive `smtp` object:
`{ set: { host, port, security, username, passwordSet } | null, effective: "tenant" | "platform" |
"env" | "none", envConfigured }`. It is `email.smtpUrl` taken apart, without its password.
`PUT /settings` accepts an optional `smtp` beside `values`:
`{ host, port, security: "starttls" | "ssl" | "none", username, password }` where `password` is
`"__unchanged__"` (keep), a string (replace) or `null` (remove). The API composes it into the one
`email.smtpUrl` secret; sending `smtp` together with a literal `email.smtpUrl` is a 400.
(`security: "none"` is for the platform scope only: a tenant's relay must encrypt.)

`POST /settings/email/test` (admin, 10 requests a minute) sends a test message to the calling
user's address and returns `{ ok, usedScope, errorClass?, error? }`. Without a body beyond
`scope` it uses the configuration in effect; with `smtp` (and optionally `from`, `replyTo`) it
exercises the unsaved form under the same egress policy, and never stores it. `errorClass` is one
of `auth_failed`, `connection_refused`, `tls_failed`, `timeout`, `host_not_found`, `blocked`,
`rejected`, `not_configured`, `unknown`; `error` is a fixed sentence for it, never the server's
words or any part of the connection string. `not_configured` means no relay is set at any scope or
in the environment, where the platform would only log the message. A relay saved at tenant or platform
scope is checked against the egress policy when it is written (`422 blocked_address`) and on every
send; the environment's relay is the deployment's own and is exempt.

## Scope targets

The scope pickers in settings and budgets must offer names, not ids typed by hand.

| Method | Path               | Query                                  | Response                                            |
| ------ | ------------------ | -------------------------------------- | --------------------------------------------------- |
| GET    | `/settings/scopes` | `scope=template \| campaign \| tenant` | `{ targets: [{ id, name, detail? }] }` newest first |

`tenant` returns the caller's own company, or every company for a platform operator.

## Operator: platform providers and routes

Contract 16 lists these; they were never implemented and the web app 404s on them. They are the
platform-level twins of the tenant routes, operator only, acting on rows with `companyId` null.

| Method       | Path                             | Same shape as           |
| ------------ | -------------------------------- | ----------------------- |
| GET/POST     | `/operator/providers`            | `/providers`            |
| PATCH/DELETE | `/operator/providers/:id`        | `/providers/:id`        |
| POST         | `/operator/providers/:id/test`   | `/providers/:id/test`   |
| GET          | `/operator/providers/:id/models` | `/providers/:id/models` |
| GET/PUT      | `/operator/providers/:id/prices` | `/providers/:id/prices` |
| GET/PUT      | `/operator/routes`               | `/routes`               |

## Operations: alert settings, notifications and background jobs (D-90 to D-92)

Two new settings categories. `ops` is platform scope only: it decides who the operator is told,
how loudly and how often, and it is what the "Operations alerts" screen edits. `notifications` is
platform and tenant: it decides which of a tenant's own people receive that tenant's notices.

| Key                            | Type     | Scopes           | Secret | Default   | Meaning                                                                                   |
| ------------------------------ | -------- | ---------------- | ------ | --------- | ----------------------------------------------------------------------------------------- |
| `ops.alertEmail`               | string   | platform         | no     | `""`      | Where operator alerts are emailed; empty falls back to `ALERT_EMAIL`, then the operator   |
| `ops.alertWebhookUrl`          | string   | platform         | yes    | `""`      | ntfy topic URL, Slack incoming webhook or generic JSON endpoint (an http or https URL)    |
| `ops.alertWebhookFormat`       | enum     | platform         | no     | `ntfy`    | `ntfy` \| `slack` \| `generic`                                                            |
| `ops.alertEmailMinSeverity`    | enum     | platform         | no     | `warning` | Lowest severity emailed: `info` \| `warning` \| `critical`                                |
| `ops.alertWebhookMinSeverity`  | enum     | platform         | no     | `info`    | Lowest severity posted to the webhook                                                     |
| `ops.alertRepeatMinutes`       | int      | platform         | no     | `60`      | When set, replaces every kind's own repeat window (1 to 10080)                            |
| `ops.alertMaxPerHour`          | int      | platform         | no     | `30`      | Alerts per audience per hour before the rest are suppressed behind one storm notice       |
| `ops.diskWarnPercent`          | int      | platform         | no     | `80`      | Disk use that raises `disk.high` as a warning                                             |
| `ops.diskCriticalPercent`      | int      | platform         | no     | `90`      | Disk use that raises it as critical                                                       |
| `ops.providerErrorRateWarn`    | number   | platform         | no     | `0.25`    | Share of a provider's calls that failed in ten minutes (at least ten calls)               |
| `ops.backupMaxAgeHours`        | int      | platform         | no     | `26`      | Hours without a successful backup before `backup.missing`                                 |
| `notifications.recipients`     | string[] | platform, tenant | no     | `[]`      | Whose addresses receive the tenant's notices; empty means every admin of the tenant       |
| `notifications.budgetWarnings` | boolean  | platform, tenant | no     | `true`    | Email the tenant's admins when a budget passes its warning threshold (not the exhaustion) |

`cost.onBudgetExceeded` is removed (D-91). There is no behaviour knob at 100 percent: the budget
pauses, and the tenant's admins and the operator are told.

**What a tenant receives.** Only `budget.warning` (at 80 and 90 percent of a budget) and
`budget.exceeded`, to the admins of the tenant the budget belongs to. The recipients are resolved
from the alert's own `companyId`; no other kind is ever addressed to a tenant.

### Background jobs (operator only)

All under `platform_operator`, audited on the job's tenant when it has one.

| Method | Path                                     | Body | Response                                                                                                                                                      |
| ------ | ---------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/operator/jobs`                         |      | `{ queues: [{ name, queued, active, deadLettered, oldestQueuedAt, expireInSeconds, retryLimit, lastFailure, runNow }] }`                                      |
| GET    | `/operator/jobs/dead?queue=&limit=`      |      | `{ queue, jobs: [{ id, queue, createdAt, sourceId, retryCount, companyId, data, error }] }`; `data` holds identifiers only, never addresses, subjects or text |
| POST   | `/operator/jobs/dead/:queue/:id/retry`   |      | `{ ok: true, queuedAs }`: the payload is queued again with a fresh attempt budget; audit `job.retry`                                                          |
| POST   | `/operator/jobs/dead/:queue/:id/discard` |      | `{ ok: true }`; audit `job.discard`                                                                                                                           |
| POST   | `/operator/jobs/run/:name`               |      | `{ ok: true, queued }`: only for the parameterless recurring jobs; audit `job.run_now`                                                                        |

`404 not_found` when the dead letter is not there; `409 conflict` when a retry could not be queued
(an identical job is already waiting), in which case the dead letter is left in place; `400` for a
queue or job name that is not in the catalog.

## Models and prices

`GET /providers/:id/models` already asks the provider for its live catalogue and imports any
prices it publishes. The response is now explicit about what happened, so the admin never has
to type a price that the provider already knows:

`{ models: ModelInfo[], importedPrices: number, fetchedAt, stale: boolean, status, error? }`

`ModelInfo` is the shared schema in `packages/shared/src/providers.ts`:
`{ id, name, contextWindow?, inputPerMtok?, cachedInputPerMtok?, outputPerMtok? }`. A provider that
publishes neither a context window nor prices still appears, with those columns empty.
When the provider cannot be reached the route answers `200` with the last imported prices,
`stale: true`, a `status` and a fixed sentence for it, so the screen degrades instead of failing.
`status` is one of `ok`, `unauthorized`, `not_found`, `rate_limited`, `provider_error`,
`unreachable`, `blocked_address`, `tls_error`, `timeout`. A refused and a filtered connection are
both `unreachable`, and text from the remote server is never returned (D-83). A price a provider
does not publish stays admin-editable through `PUT /providers/:id/prices`, and an admin override
is never overwritten by an import (`source: "admin"` wins over `"provider"`).

Routing screens populate their model field from this list for the selected provider.

`GET /providers/:id/prices` answers with rows in the stored shape, paginated:

`{ prices: [{ providerId, model, inputPerMtok, cachedInputPerMtok, outputPerMtok, source }], total, limit, offset }`

`source` is `seed`, `provider` or `admin`. `PUT /providers/:id/prices` takes
`{ prices: [{ model, inputPerMtok, outputPerMtok, cachedInputPerMtok? }] }`; an omitted
`cachedInputPerMtok` is stored as `inputPerMtok`, the whole batch is written in one transaction,
and every row it writes becomes `source: "admin"`.

`POST /providers/:id/test` takes an optional `{ model? }`. Without one it tests the model of the
newest route pointing at this provider, then the first model the provider lists, and answers `400`
when neither exists. The response names the model it used and carries the same `status` and
fixed `error` sentence as the model list: `{ ok, model, latencyMs, tokens, costCents, status, error? }`.

A provider's `baseUrl` and `headers` are checked when they are saved and again on every
connection (D-83). A tenant's base URL must be `https` on a public DNS name and port 443 or 8443;
its headers may not replace `Authorization`, `Host` or framing headers. A refused value answers
`422` with code `blocked_address`. Platform providers (operator routes) may use `http`, and may
reach a private address only for a hostname in `EGRESS_ALLOW_HOSTS`. The same rule applies to a
tenant's or the platform's `email.smtpUrl`: a public name, port 465, 587 or 2525, TLS required.

## Pagination

Every staff list that can grow without bound takes `limit` (1 to 200, default 50) and `offset`
(default 0) and answers with the list plus `{ total, limit, offset }` beside it. The list key
keeps its current name so existing clients keep working.

Paginated: `/audit`, `/campaigns`, `/campaigns/:id/sessions`, `/requirements`, `/users`,
`/budgets`, `/providers/:id/prices` (and `/operator/providers/:id/prices`), `/operator/tenants`,
`/campaigns/:id/analyses`, `/templates`.

Not paginated, because the row count is bounded by the catalogue: `/routes`, `/settings`,
`/providers`, `/stats`, `/spend`. `/templates` was on this list until D-79; a picker that wants
every template asks for `limit=200`.

## Search, sort and filters (D-79)

Every paginated list also takes these query parameters. Every list in the staff web app except
provider prices keeps them in the URL next to the page, so a reload or a shared link shows the
same rows. Provider prices are read in one request of up to 200 rows and filtered by the model
combobox on the page, so the web does not expose search for them; the API still accepts it.

| Parameter | Meaning                                                                                                                                                                                    |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `q`       | Trimmed, at most 200 characters (more is a 400). A case-insensitive substring match over the list's search fields; `%`, `_` and `\` match themselves. Empty or whitespace means no search. |
| `sort`    | One of the list's sort fields. Anything else is a 400, so nothing the caller sends reaches the database as a column name.                                                                  |
| `dir`     | `asc` or `desc`. When absent, the sort field's own default direction (the table below).                                                                                                    |
| filters   | Per list, below. Enum filters answer 400 to an unknown value rather than an empty page.                                                                                                    |
| `limit`   | 1 to 200, default 50.                                                                                                                                                                      |
| `offset`  | Default 0.                                                                                                                                                                                 |

The response shape does not change: `{ <list>, total, limit, offset }`, where `total` counts the
rows that match the search and filters, so "x to y of n" and the next-page button stay exact.
Rows with equal sort keys are ordered by id in the same direction, so pages never overlap.

In the table, a field marked "exact" must equal `q` rather than contain it. The first sort field
listed is the default sort, and each field is followed by the direction it takes when `dir` is
absent.

| Endpoint                                                          | `q` matches                                                                            | `sort` (default first, default `dir`)                                        | Filters                                                                                                                                    |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /campaigns`                                                  | `name`                                                                                 | `createdAt` desc, `name` asc, `status` asc                                   | `status`: `draft` \| `open` \| `analyzing` \| `closed`                                                                                     |
| `GET /campaigns/:id/sessions`                                     | session `id` (exact); participant `name`, `email` only when identified (below)         | `createdAt` desc, `startedAt` desc, `lastActivity` desc, `status` asc        | `status`: `created` \| `consented` \| `active` \| `paused` \| `completed` \| `deleted`                                                     |
| `GET /campaigns/:id/analyses`                                     | nothing (ignored)                                                                      | `version` desc, `createdAt` desc                                             | `status`: `queued` \| `running` \| `done` \| `failed`                                                                                      |
| `GET /requirements`                                               | `title`                                                                                | `createdAt` desc, `title` asc, `status` asc, `lastActivity` desc             | `status`: `created` \| `consented` \| `active` \| `paused` \| `completed` (deleted sessions are never listed)                              |
| `GET /templates`                                                  | `name`, `key`                                                                          | `key` asc (versions newest first within a key), `name` asc, `updatedAt` desc | `status`: `draft` \| `published` \| `archived` (absent: everything but `archived`); `origin`: `tenant` \| `platform`                       |
| `GET /users`                                                      | `email`, `name`                                                                        | `createdAt` asc, `email` asc, `name` asc, `role` asc                         | `role`: `admin` \| `member` \| `platform_operator`                                                                                         |
| `GET /audit`                                                      | `action`; `targetId` (exact); the actor's `email` or `name` (this tenant's users only) | `createdAt` desc, `action` asc                                               | `action`: one action (`campaign.create`) or a family ending in a dot (`campaign.`); `targetType` (`[a-z][a-z0-9_]*`); `from`, `to` (below) |
| `GET /budgets`                                                    | `scopeId` (exact); the name of a budgeted campaign                                     | `createdAt` asc, `limitCents` desc, `scope` asc                              | `scope`: `tenant` \| `campaign` \| `session`; `period`: `month` \| `total`                                                                 |
| `GET /providers/:id/prices`, `GET /operator/providers/:id/prices` | `model`                                                                                | `model` asc, `inputPerMtok` asc, `outputPerMtok` asc, `updatedAt` desc       | `source`: `seed` \| `provider` \| `admin`                                                                                                  |
| `GET /operator/tenants`                                           | `name`; `id` (exact)                                                                   | `createdAt` asc, `name` asc, `status` asc                                    | `status`: `active` \| `suspended`; `region` (`[a-z0-9-]+`)                                                                                 |

Notes for the screens:

- **Session identity.** `/campaigns/:id/sessions` rows carry `participantName` and
  `participantEmail`, and `q` searches them, only where the participant is identified: the
  campaign is `identified`, or it is `participant_choice` and the participant has consented
  (consent is where they choose). Everyone else gets `null` in both fields and is findable only
  by session id. An anonymous participant cannot be found by an email, even one that ended up
  stored against them. Rows also carry `lastActivityAt`, the last write to the session, which is
  what `sort=lastActivity` orders by; `startedAt` sorts sessions that never started last in both
  directions.
- **Audit dates.** `from` and `to` take an ISO date (`2026-09-21`) or an ISO date-time with `Z` or
  an offset. `from` is inclusive; `to` is inclusive, and a bare date covers that whole day in UTC.
  A range that runs backwards is a 400.
- **Templates.** One row per version. `updatedAt` is the version's creation time, because an edit
  writes a new version row.
- **Campaign rows** carry `stats: { invited, started, completed }` for the page, where `invited`
  leaves out revoked invitations and `started` is every session past `created` that is not
  `deleted`.
- **Invitations** (`/campaigns/:id/invitations`, D-360). `q` matches the address, for an
  administrator only; a member's search matches nothing and `sort=email` falls back to creation
  order. Sorts: `createdAt`, `email`, `status`, `sentAt`, `openedAt`. Filter: `status`.
- **Not searchable:** `/providers` and `/routes` (bounded by the catalogue).

The web client mirrors this table in `apps/web/src/lib/api/lists.ts` (`LISTS`), and
`listParams(searchParams, LISTS.x)` in `apps/web/src/lib/admin/pagination.ts` reads the page,
`q`, `sort`, `dir` and filters from the URL, dropping anything the list does not accept, and
returns a `query` ready for the matching `staffApi` method. `listHref` and `sortHref` build the
links that change one of them and go back to page 1.

Search is `ILIKE '%q%'` over the tenant's rows, behind companyId-led indexes (migration 0012).
Trigram indexes (`pg_trgm`) would make substring search indexable but cost an extension and a
GIN index on every write, which does not pay at thousands of rows per tenant.

## Web conventions

- **Settings** is one screen per category, listed in a sidebar beside the form, each category
  submitting on its own. A category shows which scope each value came from and offers a reset
  to the inherited value.
- **Searchable dropdowns** wherever the list is not a fixed short enum: scope targets, budget
  targets, models, providers, templates. Built on the existing popover primitive; typing
  filters, the keyboard works, and the current value is always visible.
- **Action buttons in tables are icons** with a tooltip and an accessible name; destructive
  actions keep their confirmation dialog.
- **Required fields** are marked with a red asterisk that is hidden from screen readers, which
  read the native `required` instead.
- **Paginated tables** show "x to y of n" with previous and next, and keep the page in the URL
  so a reload and a shared link land in the same place.

## Abuse limits and upload ceiling (security M1)

Two catalog keys in the `privacy` category cap the email-code flow per address and campaign:
`privacy.codeRequestsPerHour` (default 3) and `privacy.codeFailuresPerHour` (default 10). A
request over the first still answers `ok`, and an address over the second is refused with the same
"Code expired or invalid" as a wrong code (D-82). `files.maxSizeMb` now has a maximum of 50, the
platform ceiling every layer shares (D-87).

## Errors added

`403 tenant_suspended` for staff of a suspended tenant (`GET /me` still answers, with
`company.status`); `422 blocked_address` for an address the egress policy refuses; `409 conflict`
when a staff email address is already registered (D-84).

## Live voice (D-77)

Live voice is one switch with a readiness check. A tenant admin (or a platform operator acting on a
tenant with `X-Company-Id`) sees what the call needs, and turning it on without the routes asks for
an OpenAI key instead of failing. All three routes act on the caller's own tenant; none takes a
tenant id from the path or the body.

`GET /admin/voice/readiness` answers:

```json
{
  "liveVoiceEnabled": false,
  "recordedVoiceEnabled": true,
  "purposes": {
    "transcription": {
      "ready": true,
      "providerName": "OpenAI (platform)",
      "model": "whisper-1",
      "scope": "platform"
    },
    "stt_stream": { "ready": false, "scope": null },
    "tts": { "ready": false, "scope": null }
  },
  "canEnableLive": false,
  "missing": ["tts"]
}
```

Each purpose is resolved tenant route first, platform route second, exactly as the model caller
resolves it. `ready` also requires the provider to be enabled and of a kind that has audio
endpoints (not Anthropic, not OpenRouter). `transcription` and `tts` are required; `stt_stream`
(streaming captions) is optional, because without it a call transcribes per utterance (D-70).
`missing` lists the required purposes that are not ready.

`POST /admin/voice/openai` with `{ "apiKey": "sk-..." }` (20 to 512 characters) checks the key with
one authenticated model-list call, then creates the tenant's OpenAI provider, or rotates the key of
the one it already has, through the provider service (encrypted like any other key). It routes
`stt_stream` to `gpt-live-transcribe` and `tts` to `tts-1` unless the tenant already has a working
route of its own for them, and `transcription` to `whisper-1` only when nothing at any scope can
transcribe. It answers the new readiness, writes `voice.openai_connect` to the audit log with the
provider id and the purposes it routed, and never returns or logs the key. The check goes to
`OPENAI_BASE_URL` when that is set.

`PUT /admin/voice/live` with `{ "enabled": true | false }` sets `features.realtimeVoice` at tenant
scope through the settings service, writes `voice.live_toggle` to the audit log, and answers the
new readiness. Turning it off always succeeds.

| Code              | Status | When                                                                                |
| ----------------- | ------ | ----------------------------------------------------------------------------------- |
| `voice_not_ready` | 409    | `enabled: true` while a required purpose is not ready; `details.missing` names them |
| `invalid_api_key` | 422    | OpenAI refused the key; nothing was stored                                          |
| `provider_error`  | 502    | OpenAI could not be reached to check the key; nothing was stored                    |
| `validation`      | 400    | The body does not match                                                             |
| `forbidden`       | 403    | The caller is not an admin                                                          |

The web settings screen shows this as a panel at the top of the Voice category, at tenant scope: the
switch, the checklist, and a dialog that asks for the key when the switch is turned on and the call
is not ready, then turns it on once the key is connected.

## Exports and branding (D-210 to D-219)

Four catalog keys shape the PDF exports, all at platform and tenant scope, with English and Finnish
labels. There is no logo upload (D-218): a tenant brands a PDF with a name and a colour.

| Key                     | Type, default           | What it does                                                         |
| ----------------------- | ----------------------- | -------------------------------------------------------------------- |
| `branding.productName`  | string, `Discovery`     | The name on the cover, in the footer and in the file metadata        |
| `branding.primaryColor` | `#rrggbb`, `#1f4e79`    | Colour of the cover band, headings, table header tint and quote rule |
| `exports.pdfPageSize`   | `A4` or `Letter`, `A4`  | Page size                                                            |
| `exports.pdfCoverPage`  | boolean, on             | A cover page; off puts the title and version above the contents      |
| `exports.pdfFooterText` | string up to 120, empty | A line added under the footer of every page                          |

Deployment, not settings, decides where diagrams are drawn: `KROKI_URL` (environment only, reached
through the egress guard) names the renderer. A tenant cannot name one (D-213).

Audit actions added: `requirements.diagram_add`, `requirements.diagram_edit`,
`requirements.diagram_reset` (mutations, declared in the boot-time registry) and, for downloads,
`requirements.export` and `analysis.report_export` (the file format, the version, the page count and
the warnings, never the content). `x-export-warnings` and `x-export-pages` response headers carry
what a PDF left out and how long it is; the web proxy forwards them with the file name.

| Code           | Status | When                                                                      |
| -------------- | ------ | ------------------------------------------------------------------------- |
| `rate_limited` | 429    | A PDF was asked for while two others were already being composed          |
| `too_large`    | 413    | The document is over 150 pages; export the Markdown instead               |
| `validation`   | 400    | A diagram was refused; `details.issues` is a list of `{ message, line? }` |
| `conflict`     | 409    | The analysis has no report yet                                            |
