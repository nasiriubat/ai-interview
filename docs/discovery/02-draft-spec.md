# Draft spec v0.1: AI Discovery Platform

Status: DRAFT. Built on the defaults in `01-interview-round-1.md`. Items marked
`ASSUMED` can be overturned by the product owner; everything else comes from the
intake. Requirement IDs are stable and will carry into `docs/spec/` v1.0.

## 1. Problem

Companies do not know where AI and automation would actually help, because the people
who know (employees doing the daily work) are never asked systematically, and when
they are asked, the answers are not turned into anything a developer can build.
Separately, ideas that do reach a developer arrive as rough sentences, and the
developer or coding agent has to guess the requirements.

## 2. Users

| Persona                         | Workflow                  | Goal                                                                              |
| ------------------------------- | ------------------------- | --------------------------------------------------------------------------------- |
| Employee                        | 1: Discovery interview    | Describe their work honestly in under 30 minutes and see that it leads somewhere  |
| Company admin / innovation lead | 1                         | See ranked, deduplicated opportunities across the company and pick what to pursue |
| Idea owner (PM, founder, admin) | 2: Idea-to-spec interview | Turn a rough idea or a discovered opportunity into a spec a developer can act on  |
| Developer or coding agent       | 2                         | Receive a spec with no missing decisions                                          |

## 3. Workflows

### Workflow 1: Employee discovery interview

1. Admin creates a **discovery campaign** for the company and invites employees.
2. Employee opens the invite, sees the consent screen, starts a chat interview.
3. The interview engine adapts: it covers a fixed set of **topics** (role and
   responsibilities, a typical day, recurring tasks, tools used, pain points, hand-offs
   and waiting, what they would automate first) but chooses follow-ups from what the
   employee actually says. It stops when each topic has enough signal or the employee
   ends it. Sessions are resumable.
4. After each session the engine extracts **structured facts**: tasks (with frequency,
   duration, tools, pain score), pain points, and candidate opportunities.
5. Across all interviews in a campaign, the engine **clusters** candidate opportunities,
   dedupes them, and scores each on value (time saved × people affected × pain) and
   feasibility (data availability, tool access, regulatory risk).
6. Admin sees the ranked opportunity list with evidence (which interview fragments
   support it, anonymized by default) and can promote any opportunity into Workflow 2.

### Workflow 2: Idea-to-spec interview

1. Idea owner starts a **spec project** from a rough text idea or from a promoted
   opportunity.
2. The interview engine works against a **completeness rubric** (section 6). Each turn
   it picks the rubric gap with the highest impact on the build and asks about it. It
   proposes defaults the owner can accept in one word.
3. The owner can view the spec forming live beside the chat and edit any section by
   hand; edits become facts the interview respects.
4. When the rubric is satisfied (or the owner forces completion), the engine generates
   the spec and the **agent bundle**.
5. Export: Markdown download, JSON, or push to a GitHub repo as `docs/spec/`.

## 4. Functional requirements

### Tenancy, auth, roles

- FR-01 A company is a tenant; all data is scoped by company. `ASSUMED`
- FR-02 Roles: `admin`, `member`. Admins run campaigns and see dashboards; members are
  interviewed and can own spec projects. `ASSUMED`
- FR-03 Sign in with email magic link or Google. `ASSUMED`

### Workflow 1

- FR-10 Admin creates a campaign with a name, topic set (default provided), and
  invited emails or a shareable link.
- FR-11 Employee must accept a consent screen before the first message; consent is
  recorded with timestamp and version.
- FR-12 Interview is a streamed chat; the employee can leave and resume; the engine
  summarizes prior context on resume.
- FR-13 The engine tracks per-topic coverage and ends when coverage is sufficient or
  after a configurable max turn count.
- FR-14 After each session, the engine extracts tasks, pain points, and candidate
  opportunities as structured JSON validated against a schema; extraction failures are
  retried and logged, never silently dropped.
- FR-15 Campaign-level clustering merges similar opportunities and keeps links to the
  source facts.
- FR-16 Each opportunity carries a value score, a feasibility score, a one-paragraph
  rationale, and evidence snippets.
- FR-17 Admin dashboard lists opportunities sorted by score with filters by team, tool,
  and status; evidence is anonymized unless the employee opted in. `ASSUMED`
- FR-18 Admin can promote an opportunity into a spec project (Workflow 2) with the
  evidence pre-loaded as context.
- FR-19 An employee can request deletion of their transcript; deletion removes the raw
  transcript and facts but keeps aggregated cluster counts. `ASSUMED`

### Workflow 2

- FR-20 A spec project starts from free text or a promoted opportunity.
- FR-21 The interview follows the completeness rubric; each question states why it is
  being asked and offers a default.
- FR-22 The spec document is rendered live from structured state and updates after
  each turn.
- FR-23 The owner can edit any spec section directly; the engine treats edits as
  authoritative.
- FR-24 Completion produces: `spec.md`, `spec.json`, and an agent bundle (`TASK.md` with
  ordered tasks and acceptance criteria, `AGENTS.md`-style context file).
- FR-25 Export to download, and push to a GitHub repo via a user-provided token. `ASSUMED`
- FR-26 Spec versions are kept; re-opening the interview creates a new version.

### Cross-cutting

- FR-30 Every LLM call is logged with prompt version, model, tokens, latency, and
  outcome for evals and cost tracking.
- FR-31 Prompts are versioned files in the repo, not strings in code.

## 5. Non-functional requirements

- NFR-01 First token of an interview reply within 2 s at p50; streaming throughout.
- NFR-02 Data hosted in the EU; no transcript content leaves the LLM provider and the
  database. `ASSUMED`
- NFR-03 Tenant isolation enforced in the data layer (every query scoped), verified by
  a test.
- NFR-04 A failed LLM call never loses user input; the message is stored before the
  model is called.
- NFR-05 LLM provider is behind an interface; adding a second provider touches one
  package. `ASSUMED`
- NFR-06 Eval suite runs in CI on prompt changes: interview extraction accuracy and
  spec rubric completeness against fixed transcripts.

## 6. Spec completeness rubric (drives Workflow 2)

The interview is complete when every item is either answered or explicitly marked
"owner accepted default".

1. Problem statement and who has it
2. Users and their goals
3. Scope in, scope out
4. User-facing flows (happy path and the two most likely failure paths)
5. Data: entities, fields, relationships, retention
6. Interfaces: API endpoints or UI screens, with inputs and outputs
7. Business rules and edge cases
8. Non-functional: performance, security, privacy, compliance
9. Dependencies and integrations
10. Acceptance criteria per flow
11. Task breakdown ordered for a coding agent, each task independently testable
12. Open questions the owner chose to leave open, with the default taken

## 7. Data model (first cut)

```
Company(id, name, region, created_at)
User(id, company_id, email, name, role, created_at)
Campaign(id, company_id, name, topics_json, status, created_by, created_at)
Interview(id, campaign_id, user_id, status, consent_version, consented_at, coverage_json, started_at, ended_at)
Message(id, interview_id, role[user|assistant|system], content, created_at)
Fact(id, interview_id, kind[task|pain_point|opportunity], payload_json, extracted_at, extractor_version)
Opportunity(id, campaign_id, title, summary, value_score, feasibility_score, rationale, status, cluster_key)
OpportunityEvidence(opportunity_id, fact_id, snippet, anonymized)
SpecProject(id, company_id, owner_id, source[text|opportunity], source_ref, status, created_at)
SpecSession(id, spec_project_id, rubric_state_json, started_at, ended_at)
SpecMessage(id, spec_session_id, role, content, created_at)
SpecVersion(id, spec_project_id, version, spec_json, spec_md, bundle_json, created_at)
LlmCall(id, company_id, purpose, prompt_version, model, input_tokens, output_tokens, latency_ms, status, created_at)
```

## 8. Architecture (ASSUMED stack)

```
apps/web         Next.js app: interview UI, dashboard, spec editor, server routes
packages/db      Prisma schema, migrations, tenant-scoped query helpers
packages/ai      Provider interface, prompt files, interview engine, extractors,
                 clustering, spec generator, rubric
packages/shared  Zod schemas shared by ai, db, and web
evals/           Fixed transcripts and rubric checks run in CI
docs/            Discovery, spec, team roles
```

Interview engine shape: a state machine per session. State = coverage per topic (WF1)
or rubric item status (WF2). Each turn: load state and recent messages, ask the model
for the next question plus a state delta (structured output), persist both, stream the
question. Extraction and clustering are separate calls with their own prompt versions.

## 9. Out of scope for v1

Voice interviews, SSO, Slack and Teams, Jira and Linear export, billing, self-serve
company sign-up, multi-language interviews (English only), mobile apps.

## 10. Open questions

All nine questions in `01-interview-round-1.md`. Defaults are in force until answered.

## 11. Proposed build order (for the software farm)

1. Product Architect: freeze `docs/spec/` v1.0 from this draft and round-1 answers.
2. DevOps: monorepo scaffold, Postgres via Docker, CI with lint, typecheck, tests.
3. Backend: schema, auth, tenancy helper, campaign and interview endpoints.
4. AI Engineer: provider interface, WF1 interview engine, extractor, eval fixtures.
5. Frontend: consent, chat UI with streaming, resume.
6. AI + Backend: clustering and scoring; Frontend: opportunity dashboard.
7. AI Engineer: WF2 rubric engine and spec generator; Frontend: live spec editor.
8. Backend: exports and GitHub push; QA: end-to-end acceptance from FR list.
9. Dogfood: run Workflow 2 on this very spec and diff the result against `docs/spec/`.
