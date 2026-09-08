# Spec v1.1: AI Discovery and Requirements Engineering Platform

Status: FROZEN for build. Merges intake v2 (`docs/discovery/04-gap-analysis-intake-v2.md`)
and round 3 defaults (`docs/discovery/05-interview-round-3.md`). Changes go through
`docs/discovery/decisions.md` and bump this version. `ASSUMED` marks defaults the
product owner has not overturned.

## 1. Problem and principle

Organizations do not know where AI and automation would help, because the people who
know are never asked systematically, and their answers are never turned into something
a developer can build. Ideas that reach a developer arrive as rough sentences.

Principle: **understand the problem thoroughly before deciding what to build.** The
AI conducts structured discovery, challenges assumptions, uncovers missing information,
and can conclude that AI is the wrong answer.

## 2. Users

| Persona | Goal |
|---|---|
| Employee (participant) | Describe how work is actually done, identified or anonymous, by text, voice, or documents |
| Company admin | Run campaigns from templates, read the organization report, pick opportunities, manage templates, providers, budgets, privacy |
| Idea owner (technical or nontechnical) | Turn an idea or an opportunity into a reviewable, implementation-ready specification |
| Developer or coding agent | Receive a spec and implementation plan with no missing decisions |
| Platform operator | Tenants, platform providers, routing defaults, seeded templates, global spend |

## 3. Core concepts

- **Interview template**: data that defines an interview type: objective, privacy mode, participant fields, coverage areas with "done when" criteria, AI instructions, adaptivity rules, expected outputs, analysis settings, and an optional chain to another template with a field mapping.
- **Campaign**: a run of a template with a participation mode and a signed link. Workflow 1 uses campaigns; Workflow 2 sessions can exist without one.
- **Session**: one interview. Holds consent, state (coverage or rubric progress, participant profile, findings), a rolling summary, and its messages.
- **Facts**: structured outputs extracted from a session (tasks, processes, information flows, pain points, candidate opportunities, or spec fields).
- **Analysis**: collective processing across a campaign's sessions: clustering, scoring, report.
- **Opportunity**: an analysis result with seven scored factors and a solution class.
- **Specification**: the structured output of a requirements session, versioned, exportable as a document or agent bundle.
- **Hand-off**: a typed object carried from one template to the next when chaining.

## 4. Seeded templates

### `opportunity_discovery` (Workflow 1)
Coverage areas in order: role and responsibilities; daily activities; repetitive tasks;
tools and systems; manual processes; information flows and hand-offs; bottlenecks and
waiting; common problems; what they would change first. Rule: understand the role
before exploring the work. Follow-up policy: clarify when an answer is ambiguous; go
deeper when a process or problem surfaces. Instruction: learn how work is actually
performed; do not ask where AI should be used. Outputs: facts of kinds task, process,
information_flow, pain_point, opportunity_candidate. Analysis: enabled. Chains to
`requirements_discovery`.

### `requirements_discovery` (Workflow 2)
Coverage areas are the specification sections in section 8. Adaptivity: estimate the
user's technical level from early answers; technical users get architecture, API, and
data questions; nontechnical users get behavior questions and plain-language
recommendations for technical decisions. Issues pass every five turns and at
completion (section 8). Every functional requirement is tagged `mvp` or `future`, and
the engine challenges MVP items not needed for the core problem. Interview rules from
the process lesson: one decision per question when build impact is high; never default
a technology choice without asking what the team knows; enumerate administrative
surfaces explicitly; every question carries a default. Outputs: the specification.
Analysis: none. Accepts hand-off from `opportunity_discovery`.

## 5. Functional requirements

### Tenancy, identity, roles
- FR-01 Company is the tenant; every row carries `companyId`; every query is scoped by a helper; Postgres row-level security is a second fence. `ASSUMED`
- FR-02 Roles: `platform_operator`, `admin`, `member`.
- FR-03 Sign-in by email magic link or Google through Auth.js. `ASSUMED`
- FR-04 Anonymous participants never create accounts: a signed campaign link creates a participant record with only the fields the template asks for.

### Templates
- FR-60 Template CRUD per tenant, plus platform-seeded templates that tenants can copy.
- FR-61 Template fields: key, name, objective, privacy mode (`identified`, `anonymous`, `participant_choice`), participant fields, coverage areas (name, description, done-when), AI instructions, adaptivity rules, expected outputs (fact kinds or spec sections), analysis enabled, chain-to template and field mapping.
- FR-62 Templates are versioned; a campaign pins a template version.
- FR-63 Preview: an admin can run a template as a throwaway session before publishing.
- FR-64 The interview engine reads only the template; no template-specific code paths.
- FR-65 Seeded templates are stored as versioned files in the repo and loaded by migration.
- FR-66 Chaining: starting a template from another's output builds a hand-off object using the mapping; pre-filled sections are marked so the engine asks only what is missing.

### Campaigns and sessions
- FR-10 Admin creates a campaign from a template: name, participation mode (from the template's privacy mode), signed link, optional invitations, max turns, completion threshold for analysis.
- FR-11 Consent screen before the first turn; consent version and timestamp stored; anonymous sessions store no identity.
- FR-12 Streamed chat, resumable across sittings; the engine summarizes prior context on resume.
- FR-13 Engine tracks coverage per area and follows the template's follow-up policy; ends at sufficient coverage or max turns.
- FR-14 After each session, extraction produces schema-validated facts per the template's expected outputs; failures are retried and logged.

### Analysis and opportunities
- FR-15 Analysis runs on demand or when the campaign's completion threshold is reached; it clusters facts across sessions using embeddings plus a model pass, and dedupes.
- FR-16 Each opportunity has a solution class (`ai`, `automation`, `software`, `process`, `none`), seven scored factors (expected impact, affected employees, frequency, implementation complexity, data availability, risk, AI suitability) with a rationale each, and evidence links to facts.
- FR-16a `none` and `process` are first-class outcomes; the report states why AI was rejected.
- FR-17 Ranking derived from the factors with admin-tunable weights; dashboard filterable by area, tool, class, status; evidence anonymized unless the participant is identified and opted in.
- FR-17a Organization report generated as Markdown and PDF: executive summary, clusters, opportunities by class, rejected AI ideas, method and participation statistics.
- FR-18 Promote an opportunity into a requirements session with the hand-off object.
- FR-19 Participant-requested deletion removes messages, audio, attachments, and facts; aggregated cluster counts remain. Retention 24 months in v1. `ASSUMED`

### Requirements sessions
- FR-20 Start from free text, attachments, or a hand-off.
- FR-21 Each question states why it is asked and offers a default; one high-impact decision per question.
- FR-21a Technical level estimated from early answers; question style adapts; nontechnical users get recommendations with trade-offs.
- FR-21b Issues pass produces typed findings: `ambiguity`, `contradiction`, `missing_decision`, `over_complexity`; the interview resolves each finding or the owner accepts it.
- FR-22 The specification renders live from structured state after each turn.
- FR-22a Every functional requirement is tagged `mvp` or `future`.
- FR-23 Owner edits any section directly; edits are authoritative.
- FR-24 Completion produces `spec.md`, `spec.json`, and the agent bundle (`TASK.md` from the implementation phases, `AGENTS.md` context).
- FR-25 Export by download and by push to a GitHub repository. `ASSUMED`
- FR-26 Versions kept; reopening creates a new version.

### Modalities
- FR-30 Recorded voice: browser records, uploads, the `transcription` route transcribes, transcript becomes a user turn; audio retained and playable.
- FR-30a Real-time voice: a WebSocket session streams audio in and speech out through a configured real-time provider; every exchange is also persisted as messages so the engine and analysis are unchanged. Delivered after recorded voice in the same release track.
- FR-31 File turn: PDF, DOCX, MD, TXT, CSV, XLSX, PNG, JPEG up to 20 MB; ingested once into extracted text and a summary; the engine references the summary and pulls full text on demand.
- FR-32 Every modality produces the same `Message` record with a `modality` field, so the engine is modality-agnostic.

### Providers and routing
- FR-40 Provider registry: kind (`anthropic`, `openai`, `openrouter`, `litellm`, `openai_compatible`), name, base URL, encrypted key, headers, enabled; platform-level or tenant-level.
- FR-41 Live model list per provider; OpenRouter and LiteLLM prices imported.
- FR-42 Routing per tenant: purpose to provider, model, effort, max output tokens, batch allowed. Purposes: `interview_turn`, `resume_summary`, `extraction`, `clustering`, `spec_turn`, `spec_generation`, `transcription`, `file_ingest`, `vision_ingest`, `realtime_voice`, `embedding`.
- FR-43 "Test configuration" sends one small call and reports latency, tokens, cost.
- FR-44 Adapter capabilities are explicit; the engine degrades gracefully.

### Cost control
- FR-45 Ledger row per call with tokens, cache tokens, latency, status, computed cost, prompt version.
- FR-46 Price table per provider and model, seeded, admin-editable, provider-imported.
- FR-47 Budgets: tenant monthly (platform default, tenant may lower), campaign cap, session cap; guard before each call with a conservative estimate.
- FR-48 Warn at 80 percent, stop at 100 percent with a visible paused state; never silent.
- FR-49 Spend dashboard by tenant, campaign, purpose, model, day.

### Administration
- FR-70 Platform operator: tenants (create, suspend, default budget), platform providers, routing defaults, seeded templates, global spend.
- FR-71 Company admin: users and roles; templates; campaigns; results and report; requirements projects; providers and routing overrides; budgets and spend; privacy (deletion requests); audit log.
- FR-72 Participant page: consent, chat, voice, files, resume, delete my data.

### Cross-cutting
- FR-50 Prompts are versioned files in the repository.
- FR-51 Append-only audit log of admin actions and session events.

## 6. Non-functional requirements
- NFR-01 First token within 2 s at p50; streaming throughout.
- NFR-02 EU hosting; content goes only to the configured provider and the database. `ASSUMED`
- NFR-03 Tenant isolation enforced in the data layer and covered by a test; RLS enabled.
- NFR-04 User input persisted before the model is called.
- NFR-05 Adding a provider adapter touches only `packages/ai/src/providers/`.
- NFR-06 Eval suite in CI on prompt changes: extraction accuracy, coverage progression, issue detection, rubric completeness, on fixed transcripts.
- NFR-07 Provider keys encrypted at rest; never returned to the browser.
- NFR-08 Cache-hit test for providers that support caching.
- NFR-09 Everything longer than a request runs as a job with retries and visibility.

## 7. Opportunity scoring

| Factor | Scale | Meaning |
|---|---|---|
| expected_impact | 1 to 5 | Time, cost, quality, or revenue effect if solved |
| affected_employees | 1 to 5 | Share of the organization touched |
| frequency | 1 to 5 | How often the problem occurs |
| implementation_complexity | 1 to 5 (5 = simplest) | Effort to deliver |
| data_availability | 1 to 5 | Whether the needed data exists and is accessible |
| risk | 1 to 5 (5 = lowest risk) | Regulatory, safety, change-management risk |
| ai_suitability | 1 to 5 | Whether AI specifically, versus rules or software, fits |

Ranking = weighted sum, default weights equal, admin-tunable. Solution class is chosen
by the model with rationale and can be overridden by the admin.

## 8. Specification sections and issue types (requirements template)

Sections: product overview and problem; target users and roles; user stories;
functional requirements (tagged mvp or future); business rules; acceptance criteria;
technical requirements; data requirements; integrations; security and privacy;
non-functional requirements; MVP scope; future scope; implementation phases; open
questions with defaults taken.

Issue types: `ambiguity`, `contradiction`, `missing_decision`, `over_complexity`. Each
finding has a location (section), a description, a proposed resolution, and a status
(`open`, `resolved`, `accepted`).

## 9. Data model

```
Company(id, name, region, monthly_budget_cents, created_at)
User(id, company_id, email, name, role, created_at)
Participant(id, company_id, campaign_id, user_id?, fields_json, token_hash, created_at)

InterviewTemplate(id, company_id?, key, version, name, objective, privacy_mode, participant_fields_json,
  coverage_areas_json, ai_instructions, adaptivity_json, outputs_json, analysis_enabled,
  chain_to_key?, chain_mapping_json?, status[draft|published|archived], created_at)
Campaign(id, company_id, template_id, name, participation_mode, link_token_hash, max_turns,
  completion_threshold, weights_json, status, created_by, created_at)
Session(id, company_id, template_id, campaign_id?, participant_id?, owner_user_id?, source_kind, handoff_json?,
  status, consent_version?, consented_at?, state_json, summary, technical_level?, started_at, ended_at)
Message(id, session_id, seq, role, modality, content, created_at)
SessionEvent(id, session_id, seq, type[state_delta|finding|attachment|admin_note|system], payload_json, created_at)
Attachment(id, company_id, session_id, message_id?, kind, filename, mime, size_bytes, storage_key, extracted_text, summary, created_at)
Fact(id, company_id, session_id, kind, payload_json, embedding vector, extractor_version, extracted_at)
Analysis(id, campaign_id, version, status, started_at, finished_at, stats_json)
Opportunity(id, analysis_id, title, summary, solution_class, factors_json, rationale, rank_score, status, cluster_key, admin_override_json?)
OpportunityEvidence(opportunity_id, fact_id, snippet, anonymized)
Report(id, analysis_id, version, markdown, pdf_storage_key?, created_at)
SpecVersion(id, session_id, version, spec_json, spec_md, bundle_json, issues_json, created_at)

Provider(id, company_id?, kind, name, base_url?, api_key_enc, headers_json, enabled, created_at)
ModelPrice(id, provider_id, model, input_per_mtok, cached_input_per_mtok, output_per_mtok, source, updated_at)
Route(id, company_id?, purpose, provider_id, model, effort?, max_output_tokens, batch_allowed)
Budget(id, company_id, scope, scope_id, limit_cents, period, created_at)
LlmCall(id, company_id, purpose, provider_id, model, prompt_version?, input_tokens, cache_read_tokens, cache_write_tokens,
  output_tokens, latency_ms, status, cost_cents, session_id?, campaign_id?, created_at)
AuditLog(id, company_id, actor_id?, action, target_type, target_id, diff_json, created_at)
```

## 10. Architecture and stack (round 3 defaults, all `ASSUMED`)

Stack: TypeScript end to end. Fastify API plus a worker process; Next.js (App Router),
React, Tailwind, shadcn/ui as one app with role-based routes; Postgres with pgvector;
S3-compatible object storage (MinIO locally); pg-boss jobs; Auth.js; Docker Compose on
an EU VPS for the pilot.

Patterns: modular monolith with modules `identity`, `templates`, `sessions`,
`analysis`, `requirements`, `providers` (with cost), `exports`, `audit`; ports and
adapters at every external edge (model providers, object storage, transcription,
real-time voice, email, GitHub) each with an in-memory fake; interview engine as a
template-driven state machine; append-only session events and audit log; jobs for
extraction, analysis, ingestion, transcription, reports; tenancy by `companyId` plus
RLS; prompts as versioned files; evals in CI.

```
apps/web          Next.js: participant interview, admin panel, requirements workspace
apps/api          Fastify: HTTP and WebSocket API, auth, module routers
apps/worker       pg-boss consumers: extraction, analysis, ingestion, transcription, reports
packages/db       Prisma schema, migrations, tenant-scoped client, seeds (templates, prices)
packages/ai       Provider layer, cost control, interview engine, extractors, analysis, spec generation
packages/shared   Zod contracts shared by all
evals/            Fixed transcripts and checks
docs/             Discovery, spec, team
```

## 11. Out of scope for v1
SSO, Slack and Teams, Jira and Linear export, billing, self-serve company sign-up,
languages other than English, mobile apps, editable retention and consent text.

## 12. Build order
1. Done: monorepo, CI, provider layer and cost control.
2. `packages/db`: schema, migration, tenant-scoped client, seeds for templates and prices.
3. `apps/api`: auth, tenancy, templates module, campaigns and signed links, providers and routing admin, budgets.
4. `packages/ai`: template-driven interview engine, extraction, evals.
5. `apps/web`: participant interview (text, files, recorded voice), consent, resume.
6. `apps/worker` and `packages/ai`: analysis, scoring, report; `apps/web`: results dashboard, spend dashboard, admin panel.
7. Requirements template: rubric engine, issues pass, live spec editor, exports and GitHub push.
8. Real-time voice.
9. Dogfood: run `requirements_discovery` on this spec and diff the output against this file.
