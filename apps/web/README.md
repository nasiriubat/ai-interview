# @aidp/web

The Next.js web app of the AI Discovery Platform: the participant interview on the
public side, the staff admin under `/admin`. It talks only to the API contracts
(`docs/spec/16-api-contract-phase1.md` and `17-api-contract-phase2.md`); it never
touches the model or the database.

## Stack

Next.js 16 (App Router, `output: "standalone"`), React 19, TypeScript strict
(`exactOptionalPropertyTypes` on), Tailwind CSS v4, shadcn-style components on
`radix-ui`, Auth.js v5 (`next-auth@beta`) with Google and email magic links on the JWT
strategy, zod 4 (schemas imported from `@aidp/shared`), Vitest + Testing Library.
Phase 2 adds `react-markdown` + `remark-gfm` for the report and `mermaid` (loaded on
demand in the browser) for the process maps.

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

````
src/proxy.ts                     Auth.js gate for /admin/* (Next 16 "proxy", formerly middleware)
src/auth.ts, src/auth.config.ts  Auth.js: Google + Nodemailer, JWT sessions, in-memory adapter
src/i18n/en.ts                   every user-facing string; the type source for other languages
src/i18n/fi.ts                   Finnish, typed as `Strings` so a missing key fails typecheck
src/i18n/locale.ts               supported locales, `lang` cookie, Accept-Language resolution (pure)
src/i18n/index.ts                `t`: a deep proxy resolving each string against the active locale
src/i18n/server.ts               `requestLocale()` / `getStrings()` for server components and metadata
src/i18n/LocaleProvider.tsx      publishes the locale to client components
src/lib/env.ts                   API base URL, cookie names
src/lib/api/
  errors.ts                      ApiError + `{ error: { code, message } }` unwrapping
  http.ts                        Transport abstraction, request() with zod validation, requestStream()
  schemas.ts                     zod response schemas (exact where the contract is, tolerant elsewhere)
  sse.ts                         SSE parser and the typed turn stream (text | turn | ended | error)
  participant.ts, staff.ts       every endpoint of contracts 16 and 17, transport-agnostic
  server.ts                      server-side transports: Bearer token read from httpOnly cookies
  browser.ts                     browser clients that go through the /api/* proxies
  proxy.ts                       shared forwarding logic for the route-handler proxies
src/lib/analysis/rank.ts         client-side re-ranking with `rankScore` from @aidp/shared, presets,
                                 effective title/class/factors under admin overrides
src/lib/analysis/override.ts     reducer for the override sheet and the minimal PATCH payload
src/lib/report/mermaid.ts        splits report Markdown into Markdown and ```mermaid segments
src/lib/report/sections.ts       maps report sections to Markdown chunks for the section toggles
src/lib/admin/discoveryStats.ts  recognizes discovery tiles in `/stats` (by class, top by rank)
src/app/api/participant/[...path]   proxy: moves participant tokens into the `aidp_participant` cookie
src/app/api/staff/[...path]         proxy: attaches the Auth.js JWT as `Authorization: Bearer`
src/app/api/preview/[templateId]    admin template preview: cookie + redirect to /p/session
src/app/api/auth/[...nextauth]      Auth.js handlers
src/app/p/[linkToken]            arrival, email code, details, consent, path selection
src/app/p/session                the interview (streaming, widgets, progress, menu, summary)
src/app/auth/*                   sign-in, verify-request, error pages
src/app/admin/*                  dashboard, templates, campaigns, sessions, settings, providers,
                                 routes, budgets, users, audit, operator/*
src/app/admin/campaigns/[id]/results   analysis header, weights, filters, opportunity cards, compare
src/app/admin/campaigns/[id]/report    the organization report (Markdown + Mermaid, sections, print)
src/hooks/useInterview.ts        optimistic messages, SSE streaming, progress, ending, errors
src/hooks/useAnalysisPolling.ts  polls the latest analysis every 5 s while queued or running
src/hooks/useDebouncedSave.ts    persists a knob a moment after it stops changing
src/components/ui/*              shadcn-style primitives (phase 2 adds `sheet`)
src/components/common/*          language switch
src/components/widgets/*         single_choice, multi_choice, scale, ranking, yes_no + renderer
src/components/participant/*     arrival flow, message list, composer, mode switch, progress, menu, summary
src/components/admin/*           shell, forms, template editor, campaign panels, settings, providers,
                                 dashboard discovery tiles
src/components/admin/results/*   analysis header, weights panel, filters, opportunity card, factor bars,
                                 override sheet, promote dialog, compare versions
src/components/report/*          ReportView, ReportMarkdown (react-markdown), MermaidDiagram
test/                            Vitest: widgets, SSE reader, API error wrapper, interview hook,
                                 locale resolution + `t` proxy, rank/override, Mermaid + sections
````

Server components load data directly from the API with the cookie token; client
components mutate through the proxies and call `router.refresh()`.

### Languages

`en.ts` is the type source; `fi.ts` is declared as `Strings`, so a missing or extra key
fails `tsc`. Components keep importing `t` from `@/i18n`: it is a deep proxy whose leaves
resolve against the active locale when read, so module-scope shortcuts such as
`const s = t.admin.campaigns` stay correct.

The locale is the `lang` cookie when set (written by the language switch in the admin
shell and the participant headers, then `router.refresh()`), else the first supported
language in `Accept-Language`, else `en`. The root layout resolves it once per request
(`requestLocale()`), sets `<html lang>`, stores it in a per-request React `cache` store
for server components and hands it to `LocaleProvider` for client components. Page titles
use `generateMetadata` with `getStrings()` because static `metadata` exports are
evaluated at module load. Dates and numbers format with `Intl` in the active locale.

Known limit: on the server, client components share one module-level locale variable
during SSR; two concurrent requests in different languages could in theory interleave at
a Suspense boundary. The RSC side is per-request and unaffected.

### Results and report (phase 2)

`/admin/campaigns/[id]/results` loads the campaign, its analyses (newest first), the
selected one (`?version=<analysisId>`, default latest) and the campaign-scope settings.
Ranks are recomputed in the browser with `rankScore` from `@aidp/shared` whenever the
weights change; the preset and vector are saved to `analysis.weightsPreset` /
`analysis.weights` at campaign scope after a short debounce. Admin overrides
(`adminOverride`) are applied client-side over the generated title, class and factors so
the same code path renders API answers whether or not the API already merged them.

`/admin/campaigns/[id]/report` renders `report.markdown` with react-markdown (GFM, no raw
HTML) and turns ```mermaid fences into SVG in the browser (`securityLevel: "strict"`;
render errors fall back to the source). Section checkboxes hide chunks immediately and
persist to `analysis.reportSections` at campaign scope. "Download Markdown" writes the
visible Markdown to a Blob; "Print" uses the browser's print with a print stylesheet
(navigation, toolbars and controls carry `print:hidden`).

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

Phase 2 (`17-api-contract-phase2.md`):

20. **Report sections in the Markdown.** The contract lists `report.sections` but does not
    say where each section starts in `report.markdown`. The web recognizes
    `<!-- section: <key> -->` comment lines when present; otherwise the n-th level-2
    heading (`## `, outside code fences) is taken to be the n-th entry of `report.sections`.
    Content before the first section is always shown; headings beyond the list are
    always shown. TODO: agree on markers.
21. **Override PATCH semantics.** The web sends the full current override (fields equal to
    the generated values are omitted) and assumes the API _replaces_ the stored override;
    an empty body `{}` means "remove the override". Whether the returned `factors` already
    have overrides merged is not specified; the web merges `adminOverride.factors` over
    `factors` client-side, which is idempotent either way. Factor overrides without a
    rationale are sent with the generated rationale (the shared schema requires one).
22. **Analysis detail while queued.** `GET /analyses/:id` is only called for runs that are
    not `queued`; for `running`/`failed` runs the web tolerates empty `opportunities` and a
    null `report`. `stats.embedding` (`provider | lexical`) and `stats.error` are optional.
23. **`/stats` discovery tiles.** Rendered only when recognized:
    `discovery.opportunitiesByClass` (`{ ai, automation, software, process, none }`, also
    accepted as `byClass` / `bySolutionClass`) and `discovery.topOpportunities`
    (`[{ id?, title, rankScore, solutionClass?, campaignId?, campaignName? }]`, also
    `topByRank` / `top`), either under `discovery` or at the top level. Anything else goes
    through the generic renderer.
24. **Settings at campaign scope.** `GET /settings?scope=campaign&scopeId=<id>` may return
    only the overrides set at that scope; missing keys fall back to the shared defaults
    (`balanced`, weights of 1, all report sections). Weights are saved together with the
    preset every time, even when the preset is a shipped one.
25. **Promote.** After `POST /opportunities/:id/promote` the web marks the opportunity
    `promoted` locally and links to `/admin/sessions/<session.id>`; the requirements
    workspace itself is a later phase. `handoff` is validated with the shared
    `HandoffSchema` (all fields required).
26. **Diff.** `changed` pairs are keyed by `after.id` in the UI; ranks in the diff are the
    API's (stored weights), not re-ranked client-side.
27. **Language.** The UI language is the `lang` cookie / `Accept-Language`; it is not sent
    to the API. `analysis.language` (the report's language) stays a separate setting.
