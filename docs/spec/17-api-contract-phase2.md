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

Overrides are keyed by `clusterKey` and reapplied on later runs of the same campaign.

## Weights and report settings

Through `/settings` with scope `campaign` or `tenant`: `analysis.weightsPreset`, `analysis.weights`, `analysis.similarityThreshold`, `analysis.reportSections`, `analysis.preliminaryVisibleToMembers`, `analysis.departmentComparison`, `analysis.language`. Changing weights re-ranks stored opportunities on the next GET (rank is computed from stored factors).

## Trigger

Analysis is queued automatically when a session completes and the campaign reaches its completion threshold (count or percent of invited), unless a run is already queued or running. `stats.thresholdMet` is false on runs started manually below the threshold; the web labels those preliminary.

## Embeddings

Purpose `embedding` routes to an OpenAI-compatible provider's `/embeddings`. When no route exists, clustering falls back to lexical vectors in-process; `stats.embedding` reports `"provider"` or `"lexical"`.
