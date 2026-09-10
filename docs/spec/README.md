# Specification v2.0

Status: FROZEN for build, 2026-09-10. Produced from the discovery conversation
(`docs/discovery/`) and the design discussion that followed it. Covers the whole
system; delivery is divided into phases in `15-phase-plan.md`. Nothing is out of scope.

| Document | Covers |
|---|---|
| `00-overview.md` | Product, principle, users, core concepts |
| `01-workflows-and-templates.md` | Interview templates as data; the two seeded workflows; chaining |
| `02-interview-engine.md` | Turn object and widgets, question selection, stopping, difficult participants, paths, context block |
| `03-context-handling.md` | Layered context, memory, recall, evals |
| `04-analysis-and-scoring.md` | Collective analysis, clustering, seven factors, report |
| `05-requirements-interview.md` | Issue detection, MVP challenge, specification sections, exports |
| `06-participant-experience.md` | Links and uniqueness, composer, resume, ending, accessibility |
| `07-admin-dashboard.md` | Stats, configurability, admin surface |
| `08-providers-and-cost.md` | Provider registry, routing purposes, budgets, ledger |
| `09-voice-and-files.md` | Recorded voice, real-time voice cascade, file ingestion |
| `10-architecture.md` | Stack, modules, patterns, framework decision, diagrams |
| `11-security-and-privacy.md` | Tenancy, identity, anonymity, retention, secrets |
| `12-operations.md` | Production readiness: tracing, evals, jobs, flags, SLOs |
| `13-data-model.md` | Entities and relationships |
| `14-api-surface.md` | HTTP and WebSocket API by module |
| `15-phase-plan.md` | Whole-system delivery in phases |

Requirement ids: `FR-` functional, `NFR-` non-functional, `ADM-` admin knobs. Ids are
stable across versions. The decision log is `docs/discovery/decisions.md`.
