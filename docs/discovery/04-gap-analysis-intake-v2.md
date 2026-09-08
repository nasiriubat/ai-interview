# Gap analysis: intake v2 against spec v1.0

Each row is a delta. "Spec change" names the requirement that will be added or amended
in spec v1.1, which is written after round 3 answers arrive (so stack decisions land
in the same revision).

## 1. Architectural change: interview templates are data, not code

Spec v1.0 hardcoded two workflows. Intake v2 says the platform is built around
configurable **interview templates**, and the two workflows are the first two templates.

| Template field | Meaning |
|---|---|
| objective | What the interview is for, in prose the AI receives |
| privacy mode | `identified`, `anonymous`, or `participant_choice` |
| participant fields | Which personal fields are asked (name, role, department, ...) |
| coverage areas | The topics the AI must cover, each with a description and a "done when" criterion |
| AI instructions | System prompt additions, tone, depth, follow-up policy |
| adaptivity rules | How the AI adapts to the participant (for example technical vs nontechnical) |
| expected outputs | Which structured outputs are produced at the end (fact schemas, report sections, spec sections) |
| analysis | Whether collective analysis runs across sessions (clustering, scoring) |
| chain to | Which template can be started from this template's outputs, and which fields carry over |

Spec change: new section "Templates", FR-60 to FR-66. Workflow 1 and Workflow 2 become
seeded templates `opportunity_discovery` and `requirements_discovery`. The interview
engine reads a template; it no longer has two code paths.

## 2. Workflow 1 deltas

| Intake v2 says | v1.0 had | Spec change |
|---|---|---|
| Admin decides identified vs anonymous participation | consent only; identity always known | FR-11 amended: privacy mode per campaign from the template; anonymous sessions have no user link and store only the participant fields the admin chose |
| Unique interview link per campaign | invitees or share link | FR-10 amended: signed campaign link; optional per-participant links when identified |
| Interview order: role first, then activities, repetitive tasks, tools, manual processes, information flows, bottlenecks, problems | similar topic list | Coverage areas of the seeded template; ordering rule "understand role before exploring work" |
| Follow up when unclear or when more detail could reveal a process | adaptive follow-ups | FR-13 amended: explicit follow-up policy in the template: clarify when ambiguous, deepen when a process or problem is surfaced |
| Understand how work is actually done, not where employees think AI fits | implicit | AI instruction in the seeded template; extraction schema records processes and information flows, not just tasks |
| Collective analysis once enough employees complete | clustering after each session | FR-15 amended: analysis runs on demand or at a completion threshold set on the campaign |
| Report classifies areas: AI, traditional automation, software development, process improvement | opportunities had `automationType` | FR-16 amended: solution class becomes `ai`, `automation`, `software`, `process`, `none` |
| Evaluation factors: impact, affected employees, frequency, complexity, data availability, risk, AI suitability | value and feasibility scores | FR-16 amended: seven scored factors with rationale each; overall ranking derived, weights admin-tunable |
| System can conclude AI is not appropriate | not stated | FR-16a new: `none` and `process` are first-class outcomes and the report says why AI was rejected |
| Organization-level report | dashboard only | FR-17a new: generated report document (Markdown and PDF) with executive summary, clusters, opportunities, and rejected AI ideas |

## 3. Workflow 2 deltas

| Intake v2 says | v1.0 had | Spec change |
|---|---|---|
| Adapts to technical vs nontechnical user | not stated | FR-21a new: the engine estimates the user's technical level from early answers and switches question style; nontechnical users get recommendations for technical decisions with plain-language trade-offs |
| Detects unclear requirements, contradictions, missing decisions, unnecessary complexity | rubric gaps only | FR-21b new: an "issues" pass runs every N turns and at completion, producing typed findings (`ambiguity`, `contradiction`, `missing_decision`, `over_complexity`) the interview then resolves |
| Separates MVP from future features | not stated | FR-22a new: every functional requirement is tagged `mvp` or `future`; the engine challenges MVP items that are not needed for the core problem |
| Output sections: product requirements, functional requirements, user roles, user stories, business rules, acceptance criteria, technical requirements, data requirements, integrations, NFRs, MVP scope, future scope, implementation phases | rubric with 12 items | Rubric replaced by this section list; "implementation phases" replaces "task breakdown" and contains it |
| Export as human-readable document or structured Markdown for coding agents | same | unchanged |

## 4. Chaining deltas

| Intake v2 says | v1.0 had | Spec change |
|---|---|---|
| Workflow 2 inherits business problem, affected users, processes, tools, constraints, expected benefits | evidence pre-loaded | FR-18 amended: a typed hand-off object; the requirements template marks those rubric sections as pre-filled and asks only what is missing |
| Full pipeline ends in an implementation plan for a developer or coding agent | agent bundle | FR-24 amended: implementation phases are part of the spec, and the agent bundle is generated from them |

## 5. Administration deltas

Intake v2 requires template management. Spec v1.0 had providers, routing, budgets,
campaigns. The full admin surface is enumerated in round 3, question 18, for the
product owner to confirm.

## 6. Interview process lesson (recorded for the product)

The Discovery Lead skipped the backend, frontend, database, hosting, auth, admin
surface, and architecture decisions in round 1 by folding them into one default. The
product owner caught it. Rules added to the seeded `requirements_discovery` template:

1. One decision per question when the build impact is high. Never bundle.
2. Never default a technology choice before asking what the team knows.
3. Enumerate the administrative surface explicitly and ask what is missing.
4. Adapt depth to the user: a user who names LiteLLM and OpenRouter gets architecture questions, not "any preferences?".
