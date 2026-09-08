# Interview round 3: the decisions round 1 skipped

Round-2 answers first: Q10 voice = all (recorded and real-time both in v1), Q11 files =
default, Q12 keys = default. Recorded in `decisions.md`.

This round asks one decision per question. Each has options with trade-offs and a
recommendation. You are technical, so the questions are technical. Backend work is on
hold until Q13 to Q16 are answered, because they change the first migration and the
first service.

## Q13. What does your team know best?

This decides Q14 more than any other factor. A stack the team is fluent in beats a
marginally better stack every time.

- (a) TypeScript end to end
- (b) Python backend, TypeScript frontend
- (c) Something else (Java, .NET, Go, PHP)

**Why it matters:** the whole codebase. The provider layer already written is
TypeScript (about 700 lines); rewriting it in Python now costs an hour, rewriting a
year of code later costs a rewrite.

## Q14. Backend shape

- (a) **Separate API service in TypeScript (Fastify or NestJS) plus a worker process,
  Next.js only for the frontend.** Clean API for future clients (Slack bot, CLI), a real
  worker for long jobs (analysis, ingestion, transcription), no framework coupling
  between API and UI. Recommended if Q13 is (a).
- (b) Next.js route handlers as the whole backend. Fewest moving parts, but background
  jobs, WebSockets for real-time voice, and long analysis runs fight the request model.
- (c) Python FastAPI plus a worker (Celery or arq), Next.js frontend. Best ecosystem for
  document parsing, embeddings, clustering, and audio. Recommended if Q13 is (b).

**Recommendation:** (a) if your team is TypeScript-first, (c) if Python-first. Not (b):
real-time voice and collective analysis both need a long-lived process.

## Q15. Frontend

- (a) **Next.js (App Router), React, Tailwind, shadcn/ui.** Largest component ecosystem,
  streaming UI is easy, coding agents know it best. Recommended.
- (b) Nuxt (Vue), (c) SvelteKit. Fine choices; smaller ecosystems for chat and voice UI.

Sub-question: participant interview UI, admin panel, and requirements workspace as one
app with role-based routes (recommended), or separate apps?

## Q16. Database, storage, jobs, search

- (a) **Postgres with pgvector for embeddings; S3-compatible object storage for audio
  and files (MinIO locally, an EU bucket in production); pg-boss for the job queue so
  there is no Redis to run.** Recommended: one database to operate, vectors for
  clustering live next to the rows they describe.
- (b) Same but Redis plus BullMQ for jobs. Better if job volume becomes high; one more
  service to run.
- (c) A managed bundle (Supabase: Postgres, auth, storage, vectors). Fastest start; EU
  region exists; vendor coupling in auth and storage APIs.

## Q17. Hosting and deployment

- (a) **Docker Compose on an EU VPS (Hetzner, Scaleway, UpCloud) for the pilot.**
  Cheapest, EU data residency trivially true, everything containerized so it can move.
  Recommended for the first customer.
- (b) Managed platform: Vercel for the frontend, Neon or Supabase for Postgres (EU
  regions), a container host for the API and worker. Less operations, more vendors.
- (c) Kubernetes from the start. Only if you already run it.

## Q18. Authentication and identity

- (a) **Auth.js (self-hosted) with email magic link and Google; anonymous employees use
  signed campaign links and never create an account; SSO (SAML or OIDC) added per
  customer later.** Recommended: no vendor, works with any backend from Q14.
- (b) Clerk or Auth0: faster, hosted, per-user pricing, data leaves the EU unless
  configured.
- (c) Keycloak: full-featured, heavy to run.

## Q19. Admin panel: confirm the surface

Proposed v1 admin panel, grouped by who uses it. Tell me what is missing and what
should wait.

**Platform operator (you)**
- Tenants: create, suspend, default budget, region
- Platform providers: add, key, test, model list, prices
- Platform routing defaults per purpose
- Seeded templates: the two built-in templates and their versions
- Global spend and health

**Company admin**
- Users and roles
- Interview templates: list, create from built-in, edit objective, privacy mode,
  participant fields, coverage areas, AI instructions, adaptivity rules, expected
  outputs, chaining; version history; preview interview
- Campaigns: create from template, participation mode, link, invitations, progress,
  completion threshold, run analysis, close
- Results: opportunity list with the seven factors and solution class, evidence,
  organization report, export, "start requirements discovery from this"
- Requirements projects: list, status, spec versions, exports
- Providers and routing: tenant-owned providers, overrides per purpose, test
- Budgets and spend: tenant, campaign, interview; charts by purpose and model
- Privacy: deletion requests, retention settings, consent text
- Audit log

**Participant (no admin)**
- Interview page: consent, chat, voice, files, resume, delete my data

## Q20. Architecture and design patterns

Proposed, for your agreement or correction:

- **Modular monolith**, one deployable API plus one worker, modules with explicit
  boundaries: `identity`, `templates`, `interviews`, `analysis`, `requirements`,
  `providers` (with cost), `exports`, `audit`. Microservices only when a module has a
  reason to scale alone.
- **Ports and adapters** at every external edge: model providers (done), object
  storage, transcription, email, GitHub export. Each is an interface with an in-memory
  fake for tests.
- **Interview engine as a template-driven state machine.** State = coverage per area
  plus participant profile plus findings. Each turn: load state, ask the model for the
  next question and a state delta as structured output, persist, stream. Templates are
  data, so a new interview type is a new row, not new code.
- **Append-only events** for interview turns and admin actions (audit log and replay
  for evals come for free).
- **Jobs** for everything longer than a request: extraction, analysis, ingestion,
  transcription, report generation.
- **Tenancy** by `companyId` on every row, enforced by a query helper and Postgres
  row-level security as a second fence.
- **Prompts as versioned files**; evals in CI on fixed transcripts.

Alternatives you may prefer: CQRS with separate read models (more machinery than v1
needs), full DDD aggregates (fine, but only if the team practices it), microservices
(no, not at this size).

## What happens after your answers

Spec v1.1 merges intake v2 (gap analysis) and this round. Then the Backend Engineer
role starts with the schema and the template module, in the stack you chose.
