# Program: phases 0 to 5 at A+

Written 2026-10-13 after the status review (`../status-2026-10-13.md`). The owner's definition of
complete: phases 0 to 5 of the phase plan at an A on every metric (security, operations,
engineering, usability, spec coverage), for two kinds of tenant on one EU VPS (the owner's
consultancy with its clients, and self-serve companies), in independently shippable milestones,
with the "why not a chatbot" argument on a public landing page. Phases 6 to 8 stay out of scope.

Seven discipline plans sit beside this file. Each contains designs, file paths, tests, effort and
acceptance criteria. This document sequences them, removes the overlaps, and states the total.

| Plan                    | File                   | Own total | What it covers                                                                                 |
| ----------------------- | ---------------------- | --------- | ---------------------------------------------------------------------------------------------- |
| Security C+ to A        | `security.md`          | ~70 days  | Pilot blockers, RLS breadth, deletion, SSRF, uploads, keys, authz matrix, GDPR, CI gates, CSP  |
| Operations C+ to A      | `operations.md`        | ~28 days  | Alerting, job admin, observability, ledger, backups, releases, tenancy ops, load and chaos     |
| Engineering B to A      | `engineering.md`       | ~50 days  | Correctness fixes, services and splits, evals program, test coverage, gates, offline dev stack |
| Product blueprint       | `product-blueprint.md` | ~62 days  | Fifteen missing or partial phase 1 to 5 features, designed to the codebase's patterns          |
| UX design               | `ux-design.md`         | ~45 days  | Participant and admin redesign specs, design system, content design, evidence plan             |
| Copy audit en/fi        | `copy-audit.md`        | ~8 days   | 142 en and 171 fi string changes, enum labels, consent default, glossary, voice and tone guide |
| Positioning and landing | `positioning.md`       | ~8 days   | Claims inventory, differentiation argument, full landing copy, naming, proof points            |

## The honest total

Summing the plans gives about 270 engineer-days. The same work appears in more than one plan
(timeouts, the extraction transaction, job admin, PDF export, notifications, the hostility flag,
the `since` field, the e2e fake provider), so the deduplicated program is **about 200 to 220
engineer-days**. That is roughly the size of what has been built so far. With an owner directing
three to four agents in parallel on disjoint files, the calendar is **four to five months**; one
person alone is ten. "A+ on every metric" is a second build, not a polish pass. The milestones
below are ordered so that each one leaves the product better to ship than the one before, and
the program can stop after any of them.

## Decisions already made (do not reopen)

Phases 0 to 5 only. Both tenant kinds. Quality over deadline. Landing page at the web root.
Sinuttelu register in Finnish. Deletion copy says "answers, recordings and files" until deletion
removes identity. Nothing marked "planned" in the claims inventory is stated in present tense.

## Decisions still yours

Each blocks a specific item. Answer them before that item starts, not before the program.

| #   | Decision                                                                                                                 | Default if you say nothing                              | Blocks                       |
| --- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- | ---------------------------- |
| 1   | Staff identity: one tenant per email, or company carried in the token so one person can belong to several tenants        | One tenant per email                                    | Security S9, onboarding (M1) |
| 2   | After "delete my data" on an email-code campaign, may the same person start a new interview                              | Yes (keeping a hash keeps personal data)                | Deletion scope (M1)          |
| 3   | Product name: keep "Discovery", or adopt Askel (fallback Groundwork) with the tagline everywhere                         | Askel, after a trademark and domain check               | Landing page (M5)            |
| 4   | Admin vocabulary: "campaign" or "interview round" in the admin UI                                                        | Campaign for admins, "interview round" for participants | Copy pass (M2)               |
| 5   | Localize the 51-key settings catalog now, or keep English keys with a note                                               | Localize (102 strings per locale)                       | Settings UI (M3)             |
| 6   | Budget for one external penetration test at the end of the program                                                       | Yes                                                     | Security acceptance 15 (M4)  |
| 7   | Counsel reviews the DPA template and final consent wording                                                               | Yes                                                     | GDPR package (M2)            |
| 8   | Security contact address and domain for `security.txt`                                                                   | Owner's consultancy domain                              | Security docs (M4)           |
| 9   | Live voice in the first pilot, or behind the feature flag until its metrics and acceptance evidence exist                | Behind the flag for the first pilot                     | M1 scope                     |
| 10  | PDF rendering: Kroki for diagrams plus in-process PDF composition (no Chromium), accepting diagram-only Kroki dependency | Yes                                                     | PDF export (M3)              |
| 11  | Reversible migrations redefined as forward-fix plus pre-migration dump plus additive-only discipline, enforced in CI     | Yes                                                     | Migration policy (M2)        |

The blueprint's section 18 lists fourteen spec sentences to change through `decisions.md` rather
than build (Kroki PDF scope, `Provider.kind` audio kinds, `collaboration` and `realtime_voice`
keys, `batchAllowed`, `downgrade`, cluster key anchoring and others). Approve them as a batch at
the start of M2.

## Milestones

Days are engineer-days after deduplication. Each milestone ends with: `pnpm check` green with
`DATABASE_URL`, a `decisions.md` row per design choice, the status document re-graded for the
metrics the milestone touched, and a tag.

### M0. Land what exists (1 day)

Fix the three pre-commit items from the status review (`.env.example` keys, the four list pages
without `ListToolbar` or the spec 19 sentence, the Google Fonts build note). Commit the working
tree as seven commits in the order the review gives. Push. CI green.

### M1. Pilot-safe (about 35 days)

Goal: one tenant could be onboarded, interviewed and reported on with nobody lied to and nothing
silently failing. Security M1, operations M1, the correctness half of engineering M1, and the
copy that must be true.

- **Security M1** (15.5): guards moved to `onRequest`; proxy forwards the client address with a
  numeric hop count and IPv6 /64 buckets, per-email code limits; deletion removes participant,
  invitation, hashes, codes, session JSON columns and spec versions, invalidates tokens and
  rejects later writes; SSRF guard in `packages/core/src/net` for providers, SMTP and the realtime
  socket with no body echo; dependency upgrades (Next, nodemailer, OpenTelemetry, fastify) with
  `pnpm audit` and Dependabot in CI; body limits at Caddy, proxy and API multipart with the tenant
  cap checked before buffering; staff identity made deterministic; tenant suspension for
  participants, jobs and email.
- **Operations M1** (9): `AlertPort` with email and webhook, eleven alert kinds wired (budget
  warn and exceeded, dead letter, stuck job, backup failed or missing, disk, provider error rate,
  preflight failure, certificate, worker heartbeat); `expireInSeconds` per job; `/operator/jobs`
  with dead-letter retry and UI; worker heartbeat healthcheck; outbound timeouts; encrypted
  offsite backups gated on `RCLONE_REMOTE`; SHA image tags with `upgrade.sh` and `rollback.sh`;
  `OPERATIONS.md` v1. Remove `downgrade` from the catalog. Fix the "organizer has been notified"
  string.
- **Engineering M1, correctness half** (7): extraction in one transaction with a unique fact key
  and migration; retention orphan GC; SSE error event and abort through `ModelCaller`; `probe`
  purpose for provider tests; prompt version from the prompt object and dead prompt files
  deleted; email idempotency; worker handler tests; `pnpm check` that fails loudly without a
  database unless told otherwise.
- **UX and copy, truth items** (3): server locale resolved on every page; the eight strings and
  the consent default that over-promise; participant 404 that does not lead to staff sign-in.

Acceptance: every alert kind provoked by a test; anonymous requests get 401 before validation;
the erasure canary finds nothing after delete; two addresses get separate rate buckets; audit
exits clean at high; a Finnish cookie yields a fully Finnish page; `upgrade.sh` then
`rollback.sh` without a rebuild.

### M2. Trustworthy (about 55 days)

Goal: the privacy and tenancy promises in spec 11 hold, the architecture enforces the ground
rules by lint rather than review, and the participant experience has no known high-severity
usability defect.

- **Security M2** (31): RLS on every table that has or can derive a tenant, with the preflight
  inverted to enumerate all tables; evidence snippets under k; per-campaign salt and coarsened
  `openedAt`; transcript visibility per role and session DTOs; encrypted provider headers;
  streaming uploads with magic bytes, quotas and decompression limits; prompt delimiting, quote
  verification and image stripping in the report; user disable and delete; participant data
  export; audit log append-only with every mutating route declaring an action; key rotation
  keyring with HKDF subkeys and a re-encrypt job; GDPR package (export, offboarding, processing
  record, sub-processor list, DPA pointer).
- **Engineering M2** (12): tenant queries out of the eleven `routes.ts` files into services with
  `companyId` required; `TenantPrismaClient`; lint rules for ground rules 2, 4 and 5; the three
  file splits; `PageQuery` and the list envelope in `packages/shared`; role matrix and audit row
  tests generated from the route table.
- **UX M1 remainder** (9): tokens for 3:1 control contrast and a solid focus outline; `Alert`
  role prop; streaming announcer; `ModeSwitch` as a toggle group with the `mode_switch` event;
  skip, return and finish as engine state operations with the `turnCount` hack removed;
  composer newline on coarse pointers; offline state; confirmations and undo toasts per the
  policy table; form error summary with focus to the first error; dirty guard; scope picker that
  navigates.
- **Copy pass** (6): apply the 142 en and 171 fi changes, the Finnish fixes, the glossary, and
  the voice and tone guide into `docs/design/content-guide.md`.
- **Product blueprint M1 start** (8): data model alignment (`mode_switch`, `voice_metrics`,
  `Fact.language`, migration policy with CI gate); `SettingDef.since` and settings history;
  feature flag cleanup.

Acceptance: RLS conformance test with a factory per model and at most three exempt tables; no
`routes.ts` touches Prisma; zero raw enum identifiers in the UI; axe clean on participant pages
in both locales; the hostile upload corpus rejected within limits; rotation drill in staging.

### M3. Complete the spec (about 60 days)

Goal: every phase 1 to 5 requirement in the status matrix moves to implemented and tested, and
the admin experience is redesigned to the design spec.

- **Product blueprint M1 to M3** (46 remaining): notifications over `AlertPort` to tenant
  admins; hostility and distress flags surfaced; deletion confirmation email; resume recap on
  the shared `resume_summary` route with its own prompt version; prompt administration (edit,
  diff, canary, reset, rollback); cluster merge, split and rename anchored to fact ids;
  department comparison respecting k; PDF export for report and spec via Kroki plus in-process
  composition; dashboard statistics in full; template version history with rollback, settings
  carried across versions, sessions pinned to the real version, per-template voice toggle;
  diagrams as editable sections; per-turn voice metrics and the first-word SLO; self-serve
  tenant onboarding with invitation, checklist and ceilings.
- **UX M2** (14 of 19, the rest is counted in the blueprint): `Inset` and `ChoiceTile` and the
  24 bordered boxes; enum labels and `branding.currency`; settings labels, search and the
  what-changed panel; recap banner; live voice full-screen mode; consent checkbox and resend
  cooldown; onboarding checklist; campaign lifecycle page with edit, settings tab, hostility
  column, CSV export; template editor rail, versions and restore; results with the "AI is not the
  answer" section, merge bar and departments panel; requirements exports panel; providers and
  budgets polish; operator tenant dialog and jobs page; dark theme; typography and empty-state
  cleanup; decisions D-81 to D-84 and spec patches.
- **Operations M2** (10): shared telemetry with worker tracing joined by `traceparent`; child
  loggers with tenant and session ids and a redaction module; metrics with p95 first token and
  voice first word in `/stats` and `/operator/health`; `infra/observability` compose profile with
  provisioned dashboards; weekly automated restore drill with row-count assertion; ledger
  completeness (audio seconds, TTS characters, abandoned-stream estimates, provider grouping,
  spend per budget line); monthly tenant statement CSV; CHANGELOG policy, `release.sh` and the
  what's-new feed; sizing presets.

Acceptance: the per-phase lists in `product-blueprint.md` section 19 hold for phases 1 to 5
except the drills and acceptance runs reserved for M4; a trace shows one session across API and
worker; p95 first token is non-null after one interview.

### M4. Evidence and A grade (about 50 days)

Goal: every grade is backed by something the owner can rerun or point to.

- **Engineering M3** (24): fixture schema and fourteen 60-turn fixtures with gold labels;
  metrics library; deterministic replay with cassettes and a CI gate; fake model server;
  one-command offline dev stack with demo seed; Playwright harness with ten journeys and axe;
  `eval:live` with a cost cap and committed scorecards; web component and settings property
  tests; contract tests against the OpenAPI snapshot; mutation testing on the critical paths;
  CONTRIBUTING and ADRs.
- **Security M3** (24): CSP with nonces and a report-only week; abuse e2e suite; prompt-injection
  fixtures in evals with a recorded model-backed success rate; trivy and gitleaks in CI; audit
  chain verifier; `SECURITY.md`, `security.txt`, rotation and incident runbooks; external
  penetration test.
- **Operations M3** (10): tenant export and offboarding; `/operator/health`; fake provider image
  with k6 scenarios in CI at 40 participants and 5 live voices; circuit breaker and fallback
  route tier; chaos scripts; the owner's recorded restore drill from the offsite copy onto a
  machine that is not the VPS, and the chaos drill on the VPS in a quiet hour.
- **UX M3** (9): Playwright and axe across locale, viewport, reduced-motion and dark projects;
  Lighthouse budgets; contrast script over every token pair; screenshot gallery; screen-reader
  checklist runs; usability tests with five participants and three admins; polish from both.
- **Acceptance runs** (3): phase 3 regenerate-this-spec and build-from-bundle, phase 4 live
  voice on a phone with p95 under target over at least 20 samples, recorded under `docs/team/`.

Acceptance: the fifteen security criteria, the ten operations criteria, the six engineering
criteria and the UX evidence set all hold; the status document is re-graded with links.

### M5. Launch (about 10 days)

Landing page at the web root in English and Finnish from `positioning.md`, with the claims
inventory re-checked so nothing planned is in present tense; in-product wording for consent,
arrival and report cover; product name and tagline applied if decision 3 says so; the seven
proof points generated from the product (sample report, built bundle, cost per interview, time
to report, replay evidence, isolation evidence, evals); release notes; the phase plan updated to
say "Done" for phases 0 to 5 with evidence links.

## How to run the program

- **One milestone per branch, one item per commit**, with requirement and decision ids in the
  message as `AGENTS.md` requires.
- **Parallel by discipline, disjoint by file.** Security and operations work mostly in
  `apps/api`, `packages/core` and `deploy`; the blueprint in `packages/ai`, `packages/core` and
  new modules; UX and copy in `apps/web`. Merge order inside a milestone: shared contracts, then
  API, then web.
- **Every item lands with its test**, and the item is not done until the test failed before the
  change. The engineering plan's gate makes `pnpm check` refuse to pass with suites skipped.
- **Re-audit at every milestone boundary** by rerunning the six reviews that produced the status
  document, and record the new grades in a dated status file. The program is finished when the
  grades read A across the table and the per-phase acceptance lists hold.
- **The spec stays the contract.** Where a plan recommends changing a requirement rather than
  building it, the change goes through `decisions.md` first, in the M2 batch.
