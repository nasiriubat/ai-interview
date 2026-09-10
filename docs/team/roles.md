# The software farm: roles, ownership, hand-offs

The system is built by a small set of named roles. Each role owns one artifact and
hands it to the next role. A role can be a person or a coding agent; the hand-off
artifact is what matters, not who produced it.

| Role                         | Owns                                                                                                                          | Hand-off artifact                                                       | Hands to             |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------- |
| Discovery Lead (interviewer) | The adaptive interview with the product owner. Asks, listens, resolves ambiguity, records decisions.                          | `docs/discovery/0N-interview-round-N.md`, `docs/discovery/decisions.md` | Product Architect    |
| Product Architect            | System shape: workflows, data model, API contracts, module boundaries.                                                        | `docs/spec/` (the developer-ready spec)                                 | All engineers        |
| AI Engineer                  | Interview engine, prompt design, extraction of structured facts from conversation, opportunity scoring, spec generation.      | `packages/ai/` plus prompt files and eval sets                          | Backend Engineer, QA |
| Backend Engineer             | API, persistence, auth, tenancy, job orchestration.                                                                           | `apps/api/` (or server routes) with migrations                          | Frontend Engineer    |
| Frontend Engineer            | Interview UI, opportunity dashboard, spec viewer and export.                                                                  | `apps/web/`                                                             | QA                   |
| QA and Eval Engineer         | Acceptance tests from the spec, LLM eval harness (does the interview extract the right facts, does the spec meet the rubric). | `tests/`, `evals/`                                                      | Release              |
| Security and Privacy         | Consent, anonymization, PII handling, data retention, GDPR posture.                                                           | Privacy section of the spec, threat model                               | Product Architect    |
| DevOps                       | Local dev, CI, deploy, secrets.                                                                                               | `.github/workflows/`, `Dockerfile`, env docs                            | Release              |

## Working rules

1. **Nothing is built that is not in the spec.** If an engineer needs something the spec
   does not say, they raise it as an open question, the Discovery Lead resolves it with
   the product owner, and the spec is updated first.
2. **Every requirement has an ID** (`FR-xx`, `NFR-xx`) so tests, commits, and PRs can
   reference it.
3. **Assumptions are visible.** When the product owner has not decided something, the
   Discovery Lead records a default and marks it `ASSUMED`. Work proceeds on the default
   and the product owner can overturn it at any time.
4. **Hand-offs are files in this repo**, never chat history. A coding agent starting cold
   must be able to read `docs/` and know what to do.

## Current sprint: Phase 1 (see docs/spec/15-phase-plan.md)

Phase 1 is built and accepted: an anonymous participant completed the start of `opportunity_discovery` on a phone-sized browser through the web app, API, engine and a fake model; admin pages render live data. Next: run the same flow with a real provider key, then phase 2 (analysis and report).
Next milestone: an employee completes opportunity_discovery end to end on a phone.
