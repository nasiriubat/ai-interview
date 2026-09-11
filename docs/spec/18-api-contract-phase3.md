# 18 API contract, Phase 3: requirements interview

Extends contracts 16 and 17. Staff routes under `/api/v1`, tenant-scoped. A requirements
session is a `Session` on the `requirements_discovery` template with `ownerUserId` set.
Members see their own sessions; admins see every session in the tenant.

## Sessions

| Method | Path                                    | Body                                                         | Response                                                                                                                                  |
| ------ | --------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/requirements`                         |                                                              | `{ sessions: RequirementsListItem[] }` newest first                                                                                       |
| POST   | `/requirements`                         | `{ title, prompt?, path, templateId?, language? }`           | `201 { session: RequirementsSession }` (`sourceKind: "text"`)                                                                             |
| GET    | `/requirements/:id`                     |                                                              | `{ session: RequirementsSession, messages: Message[], spec: LiveSpec, versions: SpecVersionSummary[], invitations: SessionInvitation[] }` |
| POST   | `/requirements/:id/path`                | `{ path: "technical" \| "nontechnical" }`                    | `{ ok: true }` (allowed any time; the engine adapts from the next turn)                                                                   |
| POST   | `/requirements/:id/turns`               | `{ content, modality, widgetResponse? }` or empty first turn | SSE stream, same events as `/p/session/turns`, plus `event: spec` `data: { spec: LiveSpec }` after each turn                              |
| POST   | `/requirements/:id/complete`            |                                                              | `{ ok: true }` (closing on the next turn)                                                                                                 |
| POST   | `/requirements/:id/reopen`              |                                                              | `{ ok: true }` (a completed session becomes active again; the next spec version will diff against the last one)                           |
| PUT    | `/requirements/:id/sections/:key`       | `{ markdown }` (empty string clears the edit)                | `{ spec: LiveSpec }` owner edits are authoritative in the live spec and in every later version                                            |
| POST   | `/requirements/:id/findings/:findingId` | `{ outcome: "resolved" \| "accepted" \| "deferred", note? }` | `{ spec: LiveSpec }`                                                                                                                      |

`RequirementsSession`: `{ id, title, status, path, sourceKind, ownerUserId, handoff: Handoff | null, templateId, language, progress: { areas: [{ key, name, status }] }, phase, createdAt, startedAt?, endedAt? }`.
`RequirementsListItem`: `{ id, title, status, path, sourceKind, ownerUserId, ownerEmail?, versions: number, openFindings: number, createdAt, endedAt? }`.

`LiveSpec` (rendered from structured state after each turn, `packages/shared/src/requirements.ts`):
`{ title, path, context: { [key]: string }, sections: LiveSection[], findings: Finding[], decisions: Decision[], mvpChallenge: { started, done, asked: string[] }, stats: { fields, sectionsWithContent, openFindings } }`.
`LiveSection`: `{ key, title, status: "empty" | "draft" | "edited", markdown, fields: [{ path, value, source }] }`.

`Finding`: `{ id, type: "ambiguity" | "contradiction" | "missing_decision" | "over_complexity", section, path?, description, resolution, default, confidence: "low" | "medium" | "high", status: "open" | "raised" | "resolved" | "accepted" | "deferred", pushedBack, raisedTurn?, decidedTurn?, note? }`.
Findings are raised in the conversation one at a time (FR-21b); the owner can also settle any finding from the side panel with the findings route above. When the user rejects a finding the engine is confident about, it pushes back once with the concrete consequence, then records the user's choice.

## Versions and exports

| Method | Path                                           | Body                                                                 | Response                                                                                                                                  |
| ------ | ---------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/requirements/:id/versions`                   | `{ label? }`                                                         | `202 { version: SpecVersionSummary }` queued; 409 when one is already queued or running                                                   |
| GET    | `/requirements/:id/versions`                   |                                                                      | `{ versions: SpecVersionSummary[] }` newest first                                                                                         |
| GET    | `/requirements/:id/versions/:v`                |                                                                      | `{ version: SpecVersionSummary, document: SpecDocument, markdown, bundle: AgentBundle, issues: Finding[] }`                               |
| GET    | `/requirements/:id/versions/:v/diff/:other`    |                                                                      | `{ sections: [{ key, title, change: "added" \| "removed" \| "changed", lines: DiffLine[] }], requirements: { added, removed, changed } }` |
| GET    | `/requirements/:id/versions/:v/export?format=` | `md` \| `json` \| `bundle`                                           | `text/markdown`, `application/json`, or `application/zip` (the bundle files); `Content-Disposition: attachment`                           |
| POST   | `/requirements/:id/versions/:v/github`         | `{ repository: "owner/name", branch?, directory?, token, message? }` | `{ commitUrl, files: number }`; the token is used once and never stored                                                                   |

`SpecVersionSummary`: `{ id, version, label?, status: "queued" \| "running" \| "done" \| "failed", error?, createdBy?, createdAt, finishedAt?, stats: { sections, requirements, mvp, future, phases, openFindings, promptVersions: string[] } }`.

`SpecDocument`: `{ title, language, path, generatedAt, context: { [key]: string }, sections: [{ key, title, markdown, source: "generated" \| "edited" \| "fallback" }], requirements: [{ id, title, scope: "mvp" \| "future", acceptance: string[], reason?, tracedTo? }], phases: [{ key, name, goals: string[], tasks: [{ title, acceptance: string[] }], dependencies: string[], acceptance: string[] }], openQuestions: [{ question, defaultTaken }], mvp: { in: string[], movedOut: [{ id, reason }], next: string[] }, diagrams: [{ key, title, type, mermaid }] }`.
Section keys, in order: `overview, users, stories, functional, rules, technical, data, integrations, security, nfr, admin, mvp, future, phases, open_questions, diagrams`. The `requirements.specSections` setting selects and orders them.

`AgentBundle`: `{ format: "claude_code" \| "codex" \| "generic", files: [{ path, content }] }`. The bundle always contains `AGENTS.md` (context), `PLAN.md` (phases), `spec.md`, `spec.json`, and one `tasks/phase-N.md` per phase with acceptance criteria. `claude_code` adds `CLAUDE.md`; `codex` adds nothing extra (Codex reads `AGENTS.md`).

Versions are generated by the worker (`spec.generate` job, purpose `spec_generation`). When the model call fails the version is still written from the live spec with every section marked `fallback`, and `status` is `done` with `error` set.

## External invitations

An owner invites a person outside the company to answer in their place (spec 06: consultancy clients). The session stays owned by the inviting user.

| Method | Path                                          | Body        | Response                                                                                                                                                      |
| ------ | --------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/requirements/:id/invitations`               | `{ email }` | `{ invitation: SessionInvitation }`; sends an email with the link                                                                                             |
| POST   | `/requirements/:id/invitations/:invId/revoke` |             | `{ ok: true }`                                                                                                                                                |
| GET    | `/p/r/:token` (public)                        |             | `{ session: { title, productName, purpose, consentText, consentVersion, pathSelection, language }, status: "open" \| "revoked" \| "expired" \| "completed" }` |
| POST   | `/p/r/:token/open` (public)                   |             | `{ participantToken, sessionId, resume }`; then the `/p/session/*` routes of contract 16 apply                                                                |

`SessionInvitation`: `{ id, email, status: "sent" \| "opened" \| "revoked", sentAt, openedAt?, expiresAt }`. Stored on `Session.invitations` (json); the participant token is bound to the session like a campaign participant's.

## Template preview (contract 16, now implemented)

`POST /templates/:id/preview` creates a throwaway session on the template owned by the calling admin and returns `{ participantToken, sessionId }`. The web app opens it as a participant.

## Settings (ADM-REQ)

Through `/settings` with scope `tenant` or `template`: `requirements.aggressivenessTechnical`, `requirements.aggressivenessNontechnical` (`template` | `gentle` | `standard` | `strict`; `template` uses the template's `issueDetection.aggressiveness`), `requirements.mvpChallenge` (`template` | `mandatory` | `optional` | `off`), `requirements.specSections` (ordered section keys), `requirements.diagramTypes` (`context`, `containers`, `sequence`, `state`, `entity`), and `exports.bundleFormat` from contract 17. Cadence, finding types, context block questions and push-back are template fields (`issueDetection`, `contextBlock`).

## Engine behavior (spec 02, 05)

- Turn order: path (chosen before the first turn), context block, coverage areas filtered by path, findings raised as they are detected, MVP challenge once every applicable area is covered, closing question, summary.
- Issue detection runs as a separate pass (purpose `issue_detection`) over the spec state, never the transcript, every `issueDetection.everyTurns` turns and once more at completion. Gentle raises contradictions and missing decisions only; standard raises all enabled types, at most one per cadence; strict raises up to three per pass. On the nontechnical path findings in technical sections are held to the gentle rule.
- Every turn on a template whose outputs include `spec_field` records what was decided as `spec_field` facts in the state delta, so the live spec follows the conversation without waiting for extraction. A later fact with the same section and path replaces the earlier one.
- A promoted opportunity's hand-off (contract 17) seeds `spec_field` facts with `source: "handoff"` and marks the problem area partial; the engine asks only what is missing.
- Session events gain `finding` (raised, outcome) and `spec_edit`.
