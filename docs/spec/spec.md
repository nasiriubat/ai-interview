# Spec v1.0: AI Discovery Platform

Status: FROZEN for build. Supersedes `docs/discovery/02-draft-spec.md`. Changes go
through the decision log (`docs/discovery/decisions.md`) and bump the version.
Items marked `ASSUMED` are defaults the product owner has not overturned.

## 1. Problem

Companies do not know where AI and automation would help, because the employees who
know are never asked systematically, and their answers are never turned into something
a developer can build. Ideas that do reach a developer arrive as rough sentences and
the developer or coding agent guesses the rest.

## 2. Users

| Persona | Workflow | Goal |
|---|---|---|
| Employee | 1 | Describe their work by text, voice, or documents in under 30 minutes |
| Company admin | 1, admin | See ranked opportunities, run campaigns, configure providers and budgets |
| Idea owner | 2 | Turn a rough idea or a discovered opportunity into a developer-ready spec |
| Developer or coding agent | 2 | Receive a spec bundle with no missing decisions |
| Platform operator | admin | Configure platform-level providers, default budgets, tenants |

## 3. Workflows

### Workflow 1: Employee discovery interview
1. Admin creates a campaign (name, topic set, invitees or share link).
2. Employee accepts consent, then talks to the interviewer by text, recorded voice, or
   by attaching files. All three become turns in one transcript.
3. The engine covers fixed topics (role, typical day, recurring tasks, tools, pain
   points, hand-offs and waiting, what they would automate first) and adapts follow-ups
   to what the employee says. Sessions are resumable; the engine summarizes on resume.
4. After each session the engine extracts structured facts: tasks (frequency, duration,
   tools, pain score), pain points, candidate opportunities.
5. Across a campaign the engine clusters and dedupes opportunities, then scores value
   (time saved × people affected × pain) and feasibility (data access, tool access,
   regulatory risk).
6. Admin reviews the ranked list with anonymized evidence and promotes any opportunity
   into Workflow 2.

### Workflow 2: Idea-to-spec interview
1. Idea owner starts a spec project from free text, attached documents, or a promoted
   opportunity.
2. The engine works the completeness rubric (section 7): each turn targets the gap
   with the largest build impact, says why it asks, and offers a default.
3. The spec renders live beside the chat; the owner edits any section and edits are
   authoritative.
4. On completion the engine produces `spec.md`, `spec.json`, and the agent bundle.
5. Export: download, or push to a GitHub repository.

## 4. Functional requirements

### Tenancy, auth, roles
- FR-01 Company is the tenant; every row and query is company-scoped.
- FR-02 Roles: `platform_operator`, `admin`, `member`.
- FR-03 Sign in by email magic link or Google. `ASSUMED`

### Workflow 1
- FR-10 Admin creates a campaign with name, topic set (default provided), invitees or share link.
- FR-11 Consent screen before the first turn; consent version and timestamp recorded.
- FR-12 Streamed chat, resumable; engine summarizes prior context on resume.
- FR-13 Engine tracks per-topic coverage; ends at sufficient coverage or the campaign's max turn count.
- FR-14 Per-session extraction into schema-validated JSON; failures retried and logged, never dropped.
- FR-15 Campaign-level clustering with links from each opportunity to source facts.
- FR-16 Each opportunity has value score, feasibility score, rationale, evidence snippets.
- FR-17 Admin dashboard lists opportunities by score, filterable by team, tool, status; evidence anonymized unless the employee opted in.
- FR-18 Promote an opportunity into a spec project with evidence pre-loaded.
- FR-19 Employee-requested deletion removes transcript, audio, attachments, and facts; aggregated cluster counts remain. `ASSUMED`

### Workflow 2
- FR-20 Spec project starts from free text, attachments, or a promoted opportunity.
- FR-21 Interview follows the rubric; each question states its reason and a default.
- FR-22 Spec document renders live from structured state after each turn.
- FR-23 Owner edits any section directly; the engine treats edits as authoritative.
- FR-24 Completion produces `spec.md`, `spec.json`, and an agent bundle: `TASK.md` with ordered, independently testable tasks and acceptance criteria, and an `AGENTS.md`-style context file.
- FR-25 Export by download and by push to a GitHub repository with a user-supplied token. `ASSUMED`
- FR-26 Spec versions kept; reopening the interview creates a new version.

### Modalities
- FR-30 Voice turn: browser records audio, uploads it, the configured transcription purpose transcribes it, the transcript becomes a user turn; audio retained and shown as playable. `ASSUMED`
- FR-31 File turn: PDF, DOCX, MD, TXT, CSV, XLSX, PNG, JPEG up to 20 MB; ingested once into extracted text plus a generated summary; the interview references the summary and pulls full text on demand. `ASSUMED`
- FR-32 Every modality produces the same `Message` record with a `modality` field and optional attachment references, so the engine is modality-agnostic.

### Providers and model routing
- FR-40 Provider registry: kind (`anthropic`, `openai`, `openrouter`, `litellm`, `openai_compatible`), display name, base URL, encrypted API key, extra headers, enabled flag. Platform-level providers are visible to all tenants; tenant-level providers belong to one tenant.
- FR-41 Admin fetches a provider's live model list; OpenRouter and LiteLLM model lists include prices, which are imported into the price table.
- FR-42 Routing table per tenant: purpose → provider, model, effort, max output tokens, batch allowed. Purposes: `interview_turn`, `resume_summary`, `extraction`, `clustering`, `spec_turn`, `spec_generation`, `transcription`, `file_ingest`, `vision_ingest`. Platform defaults apply where a tenant has no override.
- FR-43 "Test configuration" sends one small call and reports latency, tokens, and cost.
- FR-44 Adapter capabilities are explicit: caching, structured output, effort, batch, vision, audio transcription. The engine degrades gracefully when a capability is absent (for example, JSON parsing with retry instead of structured output).

### Cost control
- FR-45 Ledger: every call records tenant, purpose, provider, model, input tokens, cache read and write tokens, output tokens, latency, status, computed cost, prompt version.
- FR-46 Price table per provider and model, seeded with defaults, admin-editable, auto-updated from providers that publish prices.
- FR-47 Budgets: platform default monthly budget per tenant (tenant admin may lower, not raise), per-campaign cap, per-interview turn cap. Guard runs before each call using a conservative estimate and records actuals after.
- FR-48 At 80 percent of any budget the admin is notified; at 100 percent calls stop and the user sees a "paused" state; the admin is notified. Never silent.
- FR-49 Spend dashboard: by tenant, campaign, purpose, model, day, against budget lines.

### Cross-cutting
- FR-50 Prompts are versioned files in the repository, not strings in code.
- FR-51 An audit log records admin actions on providers, routing, budgets, and deletions.

## 5. Non-functional requirements
- NFR-01 First token of a reply within 2 s at p50; streaming throughout.
- NFR-02 EU hosting; transcript content goes only to the configured provider and the database. `ASSUMED`
- NFR-03 Tenant isolation enforced in the data layer and covered by a test.
- NFR-04 User input is persisted before the model is called; a failed call never loses input.
- NFR-05 Adding a provider adapter touches only `packages/ai/src/providers/`.
- NFR-06 Eval suite in CI on prompt changes: extraction accuracy and rubric completeness on fixed transcripts.
- NFR-07 Provider keys encrypted at rest with a platform key; never returned to the browser.
- NFR-08 Interview prefix (system prompt, topic set) is stable and cache-marked; a cache-hit test verifies `cache_read_input_tokens` is non-zero on the second turn for providers that support caching.

## 6. Cost-control design

See `docs/discovery/03-interview-round-2.md` section A. Summary of the levers in order:
prompt caching on the stable prefix, rolling summary instead of full transcript, file
summaries instead of full text, per-purpose routing to the cheapest model that passes
its eval, batch endpoints for non-interactive purposes, effort levels low for chatty
purposes and high for spec generation, hard budgets at three levels.

## 7. Spec completeness rubric (Workflow 2)
1. Problem statement and who has it
2. Users and goals
3. Scope in and out
4. Flows: happy path and two likely failure paths
5. Data: entities, fields, relationships, retention
6. Interfaces: endpoints or screens with inputs and outputs
7. Business rules and edge cases
8. Non-functional: performance, security, privacy, compliance
9. Dependencies and integrations
10. Acceptance criteria per flow
11. Ordered task breakdown, each task independently testable
12. Open questions left open by the owner, with the default taken

## 8. Data model

```
Company(id, name, region, monthly_budget_cents, created_at)
User(id, company_id, email, name, role, created_at)

Provider(id, company_id nullable, kind, name, base_url, api_key_enc, headers_json, enabled, created_at)
ModelPrice(id, provider_id, model, input_per_mtok, cached_input_per_mtok, output_per_mtok, source[seed|admin|provider], updated_at)
Route(id, company_id nullable, purpose, provider_id, model, effort, max_output_tokens, batch_allowed)
Budget(id, company_id, scope[tenant|campaign|interview], scope_id, limit_cents, period[month|total], created_at)
LlmCall(id, company_id, purpose, provider_id, model, prompt_version, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, latency_ms, status, cost_cents, ref_type, ref_id, created_at)

Campaign(id, company_id, name, topics_json, max_turns, status, created_by, created_at)
Interview(id, campaign_id, user_id, status, consent_version, consented_at, coverage_json, summary, started_at, ended_at)
Message(id, interview_id, role, modality[text|voice|file], content, created_at)
Attachment(id, company_id, owner_type, owner_id, kind[audio|document|image], filename, mime, size_bytes, storage_key, extracted_text, summary, created_at)
Fact(id, interview_id, kind[task|pain_point|opportunity], payload_json, extractor_version, extracted_at)
Opportunity(id, campaign_id, title, summary, value_score, feasibility_score, rationale, status, cluster_key)
OpportunityEvidence(opportunity_id, fact_id, snippet, anonymized)

SpecProject(id, company_id, owner_id, source[text|opportunity], source_ref, status, created_at)
SpecSession(id, spec_project_id, rubric_state_json, started_at, ended_at)
SpecMessage(id, spec_session_id, role, modality, content, created_at)
SpecVersion(id, spec_project_id, version, spec_json, spec_md, bundle_json, created_at)

AuditLog(id, company_id, actor_id, action, target_type, target_id, diff_json, created_at)
```

## 9. Architecture

```
apps/web          Next.js: interview UI (text, voice, files), dashboards, spec editor,
                  admin (providers, routing, budgets, spend), server routes
packages/db       Prisma schema, migrations, company-scoped query helpers
packages/ai       Provider interface and adapters, model registry, cost ledger and
                  budget guard, interview engine, extractors, clustering, spec engine
packages/shared   Zod schemas shared by ai, db, web
evals/            Fixed transcripts and rubric checks run in CI
docs/             Discovery, spec, team roles
```

Provider layer contract (`packages/ai`):

```
interface Provider {
  kind, id
  capabilities: { caching, structuredOutput, effort, batch, vision, transcription }
  listModels(): Promise<ModelInfo[]>            // with prices when the provider publishes them
  chat(req: ChatRequest): AsyncIterable<ChatEvent> // streams text deltas, ends with usage
  complete<T>(req, schema): Promise<T>          // structured output where supported, validated JSON otherwise
  transcribe?(audio): Promise<Transcript>
}
```

Every call goes through `callModel(purpose, ...)`, which resolves the route, checks the
budget, invokes the adapter, and writes the ledger row. No code calls an adapter
directly.

Interview engine: state machine per session. Each turn loads state and recent messages
(or the rolling summary), asks for the next question plus a structured state delta,
persists both, streams the question.

## 10. Out of scope for v1
Real-time speech-to-speech, SSO, Slack and Teams, Jira and Linear export, billing,
self-serve company sign-up, languages other than English, mobile apps.

## 11. Build order
1. DevOps: monorepo, Postgres via Docker, CI (lint, typecheck, test).
2. AI Engineer: `packages/ai` provider layer, two adapters, model registry, price table, ledger and budget guard, with tests.
3. Backend: Prisma schema, auth, tenancy helper, provider and routing admin endpoints.
4. AI + Backend: Workflow 1 interview engine, extraction, eval fixtures.
5. Frontend: consent, chat UI with streaming, voice recording, file attach, resume.
6. AI + Backend: clustering and scoring. Frontend: opportunity dashboard, spend dashboard.
7. AI Engineer: Workflow 2 rubric engine and spec generator. Frontend: live spec editor.
8. Backend: exports and GitHub push. QA: acceptance tests from the FR list.
9. Dogfood: run Workflow 2 on this spec and diff the output against this file.
