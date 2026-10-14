# 17 API contract, Phase 2: analysis and report

Extends contract 16. All routes are staff routes under `/api/v1`, tenant-scoped.

## Analysis runs

| Method | Path                          | Body | Response                                                                         |
| ------ | ----------------------------- | ---- | -------------------------------------------------------------------------------- |
| POST   | `/campaigns/:id/analyses`     | `{}` | `202 { analysis: Analysis }` (queued; 409 when one is already running)           |
| GET    | `/campaigns/:id/analyses`     |      | `{ analyses: Analysis[] }` newest first                                          |
| GET    | `/analyses/:id`               |      | `{ analysis: Analysis, opportunities: Opportunity[], report: Report \| null }`   |
| GET    | `/analyses/:id/diff/:otherId` |      | `{ added: Opportunity[], removed: Opportunity[], changed: [{ before, after }] }` |

`Analysis`: `{ id, campaignId, version, status: "queued" \| "running" \| "done" \| "failed", preliminary: boolean, stats: { sessions, facts, clusters, participants, thresholdMet: boolean, error?: string }, startedAt?, finishedAt?, createdAt }`.

`Opportunity`: `{ id, analysisId, clusterKey, title, summary, solutionClass, factors: { [key]: { score, rationale } }, rationale, rankScore, status, adminOverride: OpportunityOverride \| null, stats: ClusterStats, dataNeeded: string[], risks: string[], whyNotAi?: string, evidence: [{ factId, snippet, anonymized }] }`.
Factor keys: `expected_impact, affected_employees, frequency, implementation_complexity, data_availability, risk, ai_suitability` (1 to 5). `rankScore` is 0 to 100 under the campaign's weights.

`Report`: `{ id, analysisId, version, markdown, sections: ReportSection[], createdAt }`. Markdown contains Mermaid fences for process maps; the web renders them client-side.

## Opportunities

| Method | Path                         | Body                                                                            | Response                                                                                                  |
| ------ | ---------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| PATCH  | `/opportunities/:id`         | `OpportunityOverride` (`title?`, `solutionClass?`, `factors?` partial, `note?`) | `{ opportunity }` re-ranked                                                                               |
| POST   | `/opportunities/:id/status`  | `{ status: "new" \| "shortlisted" \| "dismissed" }`                             | `{ opportunity }`                                                                                         |
| POST   | `/opportunities/:id/promote` | `{}`                                                                            | `{ session: { id, templateKey: "requirements_discovery" }, handoff: Handoff }`; status becomes `promoted` |

Overrides are anchored to the fact ids of the opportunity they were made on and re-attached to whichever cluster holds those facts on a later run (D-151). A title or summary override is the rename of FR-18.

## Cluster edits (FR-18, D-200 to D-202)

| Method | Path                                   | Body                                          | Response                                                                                          |
| ------ | -------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| POST   | `/analyses/:id/opportunities/merge`    | `{ opportunityIds: string[2..6], title? }`    | `202 { analysis, editId }`: the queued edit run                                                   |
| GET    | `/opportunities/:id/split-proposal`    |                                               | `{ facts: [{ id, text, part }], parts }`: fact text only, grouped by similarity                   |
| POST   | `/opportunities/:id/split`             | `{ parts: string[][] }` (2 or 3, a partition) | `202 { analysis, editId }`                                                                        |
| GET    | `/campaigns/:id/cluster-edits`         |                                               | `{ edits: [{ id, op, createdAt, revokedAt, clusters?, parts?, title? }] }`                        |
| DELETE | `/campaigns/:id/cluster-edits/:editId` |                                               | `202 { analysis }`: undo is one more edit run                                                     |
| GET    | `/analyses/:id/departments`            |                                               | `DepartmentComparison`: `{ shown, k, reason?, departments[], belowK }`; groups below k are absent |

Refusals are `409` with `details.reason` of `stale_analysis`, `rerun_required`, `in_progress`, `below_k` or `promoted`; a partition that does not place every fact exactly once is `400`.

## Statistics (spec 07, D-206)

`GET /stats` keeps its shape and gains `discovery: { byClass, notAi, top, evidence }`. Segments, each taking `from`, `to`, `campaignId`: `GET /stats/participation`, `/stats/discovery`, `/stats/requirements`, `/stats/ai`, and `/stats/health` (admins). Schemas are in `packages/shared/src/stats.ts`.

## Weights and report settings

Through `/settings` with scope `campaign` or `tenant`: `analysis.weightsPreset`, `analysis.weights`, `analysis.similarityThreshold`, `analysis.reportSections`, `analysis.preliminaryVisibleToMembers`, `analysis.departmentComparison`, `analysis.language`. Changing weights re-ranks stored opportunities on the next GET (rank is computed from stored factors).

## Trigger

Analysis is queued automatically when a session completes and the campaign reaches its completion threshold (count or percent of invited), unless a run is already queued or running. `stats.thresholdMet` is false on runs started manually below the threshold; the web labels those preliminary.

## Embeddings

Purpose `embedding` routes to an OpenAI-compatible provider's `/embeddings`. When no route exists, clustering falls back to lexical vectors in-process; `stats.embedding` reports `"provider"` or `"lexical"`.
