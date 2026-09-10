# 16 API contract, Phase 1

Base URL `/api/v1`. JSON bodies. Errors: `{ error: { code: string, message: string, details?: unknown } }`
with HTTP 400 validation, 401 unauthenticated, 403 forbidden, 404 not found, 409 conflict, 429 rate limited.
All ids are strings. Times are ISO 8601.

## Authentication

- **Staff** (platform_operator, admin, member): Auth.js session on the web app. The API accepts the
  Auth.js session JWT as `Authorization: Bearer <token>` (or the `authjs.session-token` cookie) and
  resolves `{ userId, companyId, role }`.
- **Participant**: a participant token issued by the participant flow, sent as
  `Authorization: Bearer pt.<token>` (or cookie `aidp_participant`). Scoped to one session.
- Tenant scope is derived from the principal. Platform operators may pass `X-Company-Id` to act on a tenant.

## Participant flow (public, rate limited)

| Method | Path                                                           | Body                                                                                            | Response                                                                                                                                                                                   |
| ------ | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/p/:linkToken`                                                |                                                                                                 | `{ campaign: { name, productName, purpose, expectedMinutes, participationMode, verification, consentText, participantFields[], pathSelection }, status: "open" \| "closed" \| "expired" }` |
| POST   | `/p/:linkToken/verify/request`                                 | `{ email }`                                                                                     | `{ ok: true }` (always, to avoid enumeration)                                                                                                                                              |
| POST   | `/p/:linkToken/verify/confirm`                                 | `{ email, code }`                                                                               | `{ participantToken, sessionId, resume: boolean }`                                                                                                                                         |
| POST   | `/p/:linkToken/open` (verification `open` or invitation links) | `{ invitationToken? }`                                                                          | `{ participantToken, sessionId, resume }`                                                                                                                                                  |
| GET    | `/p/session`                                                   |                                                                                                 | `{ session: { id, status, path, modePreference, consented, progress: { areas: [{ key, name, status }] }, messages: Message[] , summary? } }`                                               |
| POST   | `/p/session/consent`                                           | `{ consentVersion, participantFields?: {}, participationChoice?: "identified" \| "anonymous" }` | `{ ok: true }`                                                                                                                                                                             |
| POST   | `/p/session/path`                                              | `{ path: "technical" \| "nontechnical" }`                                                       | `{ ok: true }`                                                                                                                                                                             |
| POST   | `/p/session/mode`                                              | `{ mode: "chat" \| "options" \| "voice" }`                                                      | `{ ok: true }`                                                                                                                                                                             |
| POST   | `/p/session/turns`                                             | `{ content, modality: "text" \| "widget", widgetResponse? }` or empty body for the first turn   | SSE stream (below)                                                                                                                                                                         |
| POST   | `/p/session/pause`                                             |                                                                                                 | `{ ok: true }`                                                                                                                                                                             |
| POST   | `/p/session/complete`                                          |                                                                                                 | `{ ok: true }` ("I'm done": triggers closing on next turn)                                                                                                                                 |
| DELETE | `/p/session`                                                   |                                                                                                 | `{ ok: true }` (delete my data)                                                                                                                                                            |
| GET    | `/p/session/summary`                                           |                                                                                                 | `{ summary, facts: Fact[] }` (end-of-session summary the participant may edit)                                                                                                             |
| PUT    | `/p/session/summary`                                           | `{ summary }`                                                                                   | `{ ok: true }`                                                                                                                                                                             |

`Message`: `{ id, seq, role, modality, content, widget?, widgetResponse?, areaKey?, createdAt }`.

### SSE stream for turns

`Content-Type: text/event-stream`. Events:

- `event: text` `data: { "delta": string }`
- `event: turn` `data: { message: Message, ended: boolean, progress: { areas: [{ key, name, status }] } }`
- `event: ended` `data: { summaryAvailable: boolean }`
- `event: error` `data: { code, message }` (for example `budget_exceeded`, `provider_error`)

## Staff routes

| Method          | Path                                                     | Notes                                                                                                                                    |
| --------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| GET             | `/me`                                                    | `{ user: { id, email, name, role, companyId }, company: { id, name } }`                                                                  |
| GET/POST        | `/users`, PATCH `/users/:id`                             | admin                                                                                                                                    |
| GET             | `/templates`                                             | platform seeded (companyId null) plus tenant templates                                                                                   |
| GET             | `/templates/:id`                                         |                                                                                                                                          |
| POST            | `/templates`                                             | `InterviewTemplateInput` (shared schema) plus `{ copyFromId? }`                                                                          |
| PUT             | `/templates/:id`                                         | creates a new version; body `InterviewTemplateInput`                                                                                     |
| POST            | `/templates/:id/publish`, `/archive`                     |                                                                                                                                          |
| GET             | `/templates/:id/diff-shipped`                            | `{ shipped, current, changedFields[] }`                                                                                                  |
| POST            | `/templates/:id/preview`                                 | creates a throwaway session for the admin; returns `{ participantToken, sessionId }`                                                     |
| GET/POST        | `/campaigns`                                             | POST `{ templateId, name, participationMode?, verification?, allowedEmailDomains?, maxTurns?, completionThreshold?, expiresAt? }`        |
| GET             | `/campaigns/:id`                                         | includes `{ link: { url }, stats: { invited, started, completed, dropOffByArea } }`                                                      |
| PATCH           | `/campaigns/:id`                                         |                                                                                                                                          |
| POST            | `/campaigns/:id/open`, `/close`                          |                                                                                                                                          |
| POST            | `/campaigns/:id/invitations`                             | `{ emails: string[] }` → `{ created, skipped }`; sends emails                                                                            |
| GET             | `/campaigns/:id/invitations`                             | statuses (emails shown only when identified)                                                                                             |
| POST            | `/campaigns/:id/invitations/:invId/remind`, `/revoke`    |                                                                                                                                          |
| GET             | `/campaigns/:id/sessions`                                | list with status, progress, cost; transcripts only per privacy setting                                                                   |
| GET             | `/sessions/:id`                                          | staff view, subject to privacy setting                                                                                                   |
| GET             | `/sessions/:id/events`                                   | replay                                                                                                                                   |
| GET/PUT         | `/settings?scope=&scopeId=`                              | `{ values: { key: value }, catalog: [{ key, category, description, default, scopes }] }`; PUT `{ values }` validates against the catalog |
| GET/POST        | `/providers`, PATCH/DELETE `/providers/:id`              | keys never returned; `hasKey: boolean`                                                                                                   |
| POST            | `/providers/:id/test`                                    | `{ ok, latencyMs, tokens, costCents, error? }`                                                                                           |
| GET             | `/providers/:id/models`                                  | live list, imports prices                                                                                                                |
| GET/PUT         | `/providers/:id/prices`                                  |                                                                                                                                          |
| GET/PUT         | `/routes`                                                | `{ routes: Route[] }` per purpose, tenant overrides over platform defaults                                                               |
| GET/POST/DELETE | `/budgets`                                               |                                                                                                                                          |
| GET             | `/spend?from=&to=&groupBy=day\|purpose\|model\|campaign` | `{ rows: [{ key, costCents, calls, tokens }], budget: { limitCents, spentCents } }`                                                      |
| GET             | `/stats`                                                 | participation and AI operation numbers for the dashboard                                                                                 |
| GET             | `/audit?from=&to=`                                       |                                                                                                                                          |
| GET             | `/health/live`, `/health/ready`                          | public                                                                                                                                   |

Platform operator only: `/operator/tenants` (GET/POST/PATCH), `/operator/providers` (platform-level),
`/operator/routes` (platform defaults), `/operator/stats`.

## Web app contract notes

- The web app never talks to the model or the database; only this API.
- Participant pages use the participant token; staff pages use the Auth.js session.
- OpenAPI is served at `/api/v1/openapi.json`; the web app generates its client from it.
