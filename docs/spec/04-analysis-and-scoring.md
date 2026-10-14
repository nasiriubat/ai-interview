# 04 Analysis and scoring

## Trigger

- FR-15 Runs when the campaign reaches its completion threshold (default 5 completed interviews or 30 percent of invited, whichever comes first) or when the admin presses Analyze now. Below threshold the result is labeled preliminary. Each run is a version; two versions can be diffed.

## Pipeline (background jobs, batch-priced where the provider allows)

1. Normalize facts from every completed session, with role and department when known.
2. Embed facts; cluster by similarity; a model pass merges or splits clusters and names them.
3. Per cluster: summary, affected roles, participants mentioning it, aggregated frequency and time, tools, representative quotes.
4. Per cluster, opportunity generation: solution class (`ai`, `automation`, `software`, `process`, `none`), seven factors with a rationale each, data needed, risks. "None" is an allowed and expected outcome (FR-16a).
5. Dedupe across clusters; rank with tenant weights; produce the report and process maps.

## Factors (FR-16)

| Factor                    | Scale                 | Meaning                                          |
| ------------------------- | --------------------- | ------------------------------------------------ |
| expected_impact           | 1 to 5                | Time, cost, quality, or revenue effect if solved |
| affected_employees        | 1 to 5                | Share of the organization touched                |
| frequency                 | 1 to 5                | How often the problem occurs                     |
| implementation_complexity | 1 to 5, 5 simplest    | Effort to deliver                                |
| data_availability         | 1 to 5                | Needed data exists and is accessible             |
| risk                      | 1 to 5, 5 lowest risk | Regulatory, safety, change-management risk       |
| ai_suitability            | 1 to 5                | AI specifically, versus rules or software, fits  |

Rank = weighted sum, weights admin-tunable, presets: balanced, quick wins, strategic.

## Anonymity rule

- FR-17 A quote or a department breakdown appears only when at least k participants (default 3) are behind it. Department comparison is shown when each compared department has at least k.

## Report (FR-17a)

Executive summary; participation and method; work map (clusters by area with time
share, as Mermaid process maps); opportunities by solution class with the factor table;
quick wins vs strategic bets; where AI is not appropriate and why; recommended next three
opportunities for requirements discovery. Markdown and PDF; sections can be hidden.

## Admin actions on results

Merge or split clusters, rename, override class or factors with a note, dismiss,
shortlist, promote to requirements discovery (FR-18). Overrides survive re-runs.

A merge or split is anchored to the member fact ids of the clusters it was made on, never to a
cluster key, and is applied after clustering in every run: an anchor attaches to the cluster
holding at least half of its facts, and an edit that matches nothing is skipped and reported
(D-200). An edit produces the next version as an edit run that costs a model call only for the
clusters that changed (D-201). A cluster below k cannot be split, because its facts are not shown.

Department comparison (FR-17, D-203): participants are counted, not facts. A department is
shown at k or more; smaller ones are pooled into an unnamed "Other" only when the pool reaches k,
and are otherwise left out with no total that would let them be subtracted. A department-by-
opportunity cell needs k people of its own.

## Admin knobs (ADM-ANALYSIS)

Threshold, k, weights and presets, similarity strictness, report sections, preliminary
visibility to members, department comparison on or off.
