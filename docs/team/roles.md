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

## Current state: phases 1-4 built, deployable

Phases 1, 2 and 3 are built, accepted, and each run end to end against a real model through
OpenRouter rather than against the fake one. Phase 4 is built except for its real-time half.

- **Phase 1, participant interviews.** Adaptive interviews on a phone-sized browser, streaming over
  SSE, with consent, participant tokens and per-turn fact extraction.
- **Phase 2, campaign analysis.** API, job queue, worker and pipeline, with the results dashboard
  and report in the browser. The live run took five interviews to 55 facts, 8 clusters and 8 ranked
  opportunities with a report containing process maps and the k-anonymity statement.
- **Phase 3, requirements interview** (contract `docs/spec/18-api-contract-phase3.md`). Path
  selection and the context block, per-turn specification capture, the separate issue-detection
  pass with push-back, the MVP challenge, the live spec editor with authoritative owner edits,
  versioned generation by the worker, spec.md / spec.json / agent-bundle exports, GitHub push,
  chaining from promoted opportunities, and external invitations. Replay evals cover both seeded
  templates.
- **Phase 4, files and recorded voice.** A participant can attach a document or an image and it is
  read once — extracted or described, summarized, chunked — with the summary in the interviewer's
  context every turn and the wording recalled on demand. They can answer by speaking: the recording
  is stored, transcribed and answered in one request, and kept playable under its own retention
  clock. The real-time voice cascade (FR-30a) is not built.

Deployment is owned and documented: `deploy/compose.prod.yml` with Caddy, nightly backups, a
tested restore drill and a preflight gate that refuses to start the stack unless row-level security
is genuinely in force. The runbook is `docs/DEPLOY.md`.

**Known gap in the live configuration.** Clustering falls back to lexical similarity because no
embedding route is configured; OpenRouter serves no embedding models. Configure an embedding
purpose against a provider that has them (a direct OpenAI or Voyage key) to get semantic
clustering. The fallback is deliberate and the pipeline reports which path it took.

Next: the real-time voice cascade, then the phase 3 acceptance test in `15-phase-plan.md`
(regenerate this spec from a rough prompt; build a feature from the bundle). Phases 6 (integrations),
7 (collaboration) and 8 (billing) are specified and not built.
