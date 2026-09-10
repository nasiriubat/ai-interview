# @aidp/web

The Next.js web app of the AI Discovery Platform: the participant interview on the
public side, the staff admin under `/admin`. It talks only to the Phase 1 API
(`docs/spec/16-api-contract-phase1.md`); it never touches the model or the database.

## Stack

Next.js 16 (App Router, `output: "standalone"`), React 19, TypeScript strict
(`exactOptionalPropertyTypes` on), Tailwind CSS v4, shadcn-style components on
`radix-ui`, Auth.js v5 (`next-auth@beta`) with Google and email magic links on the JWT
strategy, zod 4 (schemas imported from `@aidp/shared`), Vitest + Testing Library.

The shadcn registry (`ui.shadcn.com`) was not reachable from the build environment, so
the components under `src/components/ui/` are written by hand in the shadcn "new-york"
style on top of the `radix-ui` umbrella package. `components.json` is in place so the
CLI can add more later.

## Run

```sh
cp apps/web/.env.example apps/web/.env      # fill AUTH_SECRET, Google, SMTP
pnpm install
pnpm --filter @aidp/shared build            # the web app imports the built package
pnpm --filter @aidp/web dev                 # http://localhost:3000
```

Scripts: `dev`, `build`, `start`, `typecheck` (`tsc --noEmit`), `lint` (root ESLint
config), `test` (Vitest, jsdom).

Docker (from the repository root): `docker build -f apps/web/Dockerfile .` produces a
standalone image listening on port 3000.

Environment: `NEXT_PUBLIC_API_URL` (API origin, `/api/v1` is appended), `AUTH_SECRET`
(shared with the API so it can decode the Auth.js JWT), `AUTH_GOOGLE_ID`,
`AUTH_GOOGLE_SECRET`, `EMAIL_SERVER`, `EMAIL_FROM`.

## Structure

```
src/proxy.ts                     Auth.js gate for /admin/* (Next 16 "proxy", formerly middleware)
src/auth.ts, src/auth.config.ts  Auth.js: Google + Nodemailer, JWT sessions, in-memory adapter
src/i18n/en.ts                   every user-facing string (phase 2 adds languages here)
src/lib/env.ts                   API base URL, cookie names
src/lib/api/
  errors.ts                      ApiError + `{ error: { code, message } }` unwrapping
  http.ts                        Transport abstraction, request() with zod validation, requestStream()
  schemas.ts                     zod response schemas (exact where the contract is, tolerant elsewhere)
  sse.ts                         SSE parser and the typed turn stream (text | turn | ended | error)
  participant.ts, staff.ts       every endpoint of the contract, transport-agnostic
  server.ts                      server-side transports: Bearer token read from httpOnly cookies
  browser.ts                     browser clients that go through the /api/* proxies
  proxy.ts                       shared forwarding logic for the route-handler proxies
src/app/api/participant/[...path]   proxy: moves participant tokens into the `aidp_participant` cookie
src/app/api/staff/[...path]         proxy: attaches the Auth.js JWT as `Authorization: Bearer`
src/app/api/preview/[templateId]    admin template preview: cookie + redirect to /p/session
src/app/api/auth/[...nextauth]      Auth.js handlers
src/app/p/[linkToken]            arrival, email code, details, consent, path selection
src/app/p/session                the interview (streaming, widgets, progress, menu, summary)
src/app/auth/*                   sign-in, verify-request, error pages
src/app/admin/*                  dashboard, templates, campaigns, sessions, settings, providers,
                                 routes, budgets, users, audit, operator/*
src/hooks/useInterview.ts        optimistic messages, SSE streaming, progress, ending, errors
src/components/ui/*              shadcn-style primitives
src/components/widgets/*         single_choice, multi_choice, scale, ranking, yes_no + renderer
src/components/participant/*     arrival flow, message list, composer, mode switch, progress, menu, summary
src/components/admin/*           shell, forms, template editor, campaign panels, settings, providers, ...
test/                            Vitest: widgets, SSE reader, API error wrapper, interview hook
```

Server components load data directly from the API with the cookie token; client
components mutate through the proxies and call `router.refresh()`.

### Tokens never reach client JavaScript

- Participant: `verify/confirm` and `open` are proxied; the proxy strips
  `participantToken` from the response and sets it as the `aidp_participant` httpOnly
  cookie. All `/p/session/*` calls (including the SSE turn stream) go through the proxy,
  which adds `Authorization: Bearer pt.<token>`. `DELETE /p/session` clears the cookie.
- Staff: the Auth.js session cookie (`authjs.session-token`, a JWE) is forwarded as
  `Authorization: Bearer` by server components and by the `/api/staff` proxy. Platform
  operators may send `X-Company-Id`; the proxy passes it through.

### Accessibility

Mobile-first layouts, visible focus rings, skip link, labeled controls, `aria-live`
regions for streaming and status, keyboard-operable widgets (arrow keys on the scale,
up/down buttons on the ranking), reduced-motion safe typing indicator, dialogs with
focus management from Radix.

## Contract gaps

Things the web app needs that `16-api-contract-phase1.md` does not spell out. Each is
implemented with an assumption and is easy to adjust once the API lands.

1. **Skip / come back to an area.** No endpoint exists. The progress indicator sends a
   text turn `"Let's skip this for now (<area>)"` or `"Let's come back to <area>"`
   (strings in `src/i18n/en.ts`). TODO: replace with a dedicated endpoint when one exists.
2. **"I'm done" flow.** The contract says `POST /p/session/complete` "triggers closing on
   next turn". The app posts `complete` and then sends a text turn `"I'm done"` so the
   closing question streams immediately. TODO: confirm the API expects a follow-up turn.
3. **`consentVersion`.** Not returned by `GET /p/:linkToken`. The app sends a stable hash
   of the consent text shown (`consentVersion(text)` in `ArrivalFlow.tsx`). TODO: expose
   the version on the link payload.
4. **Verification errors.** The app maps 400/401/403 on `verify/confirm` to "invalid
   code" and recognizes an optional `domain_not_allowed` error code. TODO: agree on codes.
5. **`GET /stats` and `GET /operator/stats` shape.** Not specified; the dashboard renders
   any groups of numeric values generically (`StatsGroups`). Known group keys get labels
   (`participation`, `ai`, `discovery`, `requirements`, `health`).
6. **List envelopes.** For lists without a spelled-out shape (templates, campaigns,
   invitations, sessions, users, providers, budgets, audit, tenants, models, prices) the
   client accepts either a bare array or `{ items | rows | entries | data | <name>: [] }`.
   Single records accept either the bare object or `{ template | campaign | session |
provider | tenant: {...} }`.
7. **Template records.** Assumed `InterviewTemplate` fields plus `id`, `companyId`
   (null for shipped), `status: draft | published | archived`, timestamps. The list is
   allowed to be lighter (id, key, name, version, companyId, status, updatedAt).
8. **Campaign records.** Assumed `templateKey`, `stats`, `link` as in the contract's
   detail response; `verification` and `participationMode` echoed back.
9. **Session list rows.** Assumed `costCents`, `progress`, `participantEmail?` (only when
   identified), `updatedAt`. Staff session detail assumed `messages?` (omitted or empty
   when the privacy setting hides transcripts) and `campaignId?`.
10. **Settings catalog** carries no type. Input kinds come from the shared `SETTINGS`
    zod schemas by key; unknown keys fall back to the type of `default`.
11. **`/providers/:id/models`** "imports prices": the app treats the response as a list of
    `ModelInfo` and merges it into the editable price table, then `PUT /prices` with
    `{ prices: ModelInfo[] }`. TODO: confirm the PUT body.
12. **`/routes` PUT** sends `{ routes: Route[] }` with the tenant's `companyId` (or null
    for platform defaults); rows without a provider mean "inherit".
13. **`/budgets`** POST sends a `BudgetLimit`; rows are assumed to carry an `id` for DELETE.
14. **`/audit`** rows: assumed `createdAt | at`, `actor | actorEmail | userId`, `action`,
    `target | targetType + targetId`, `diff | details`.
15. **`/operator/tenants`** rows: assumed `id, name, status?, region?, defaultBudgetCents?,
createdAt?`; PATCH with `{ status: "suspended" | "active" }` to suspend/activate.
16. **`/operator/providers/:id/{test,models,prices}`** are assumed to mirror the tenant
    routes.
17. **Auth.js email provider** needs verification-token storage; the API has no such
    endpoint, so `src/lib/auth/adapter.ts` keeps tokens in memory (single instance).
    Roles are not in the JWT: `/admin` layouts resolve them via `GET /me`. Any Google
    account can sign in to the web app; the API decides who is staff (401/403 → "no
    access" banner).
18. **Session `status` values** assumed from the state diagram in `10-architecture.md`:
    `created, consented, active, paused, completed, deleted`.
19. **Voice mode** is a disabled placeholder ("coming in phase 4"); `POST /p/session/mode`
    is only ever called with `chat` or `options`.
