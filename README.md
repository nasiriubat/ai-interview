# AI Discovery Platform

An AI-powered discovery platform with two workflows:

1. **Employee discovery interviews** that surface daily work, pain points, and
   high-value AI and automation opportunities across a company.
2. **Idea-to-spec interviews** that turn rough ideas or discovered opportunities into
   developer-ready specifications, consumable by humans and by coding agents such as
   Codex and Claude Code.

This repository is built using the product's own process. Start reading here:

- `docs/discovery/00-intake.md` — the raw idea, verbatim
- `docs/discovery/01-interview-round-1.md` — the discovery interview and its defaults
- `docs/discovery/decisions.md` — decision log (DECIDED vs ASSUMED)
- `docs/discovery/02-draft-spec.md` — draft spec v0.1 (historical)
- `docs/team/roles.md` — the role-based team and hand-offs

- `docs/discovery/03-interview-round-2.md` — cost control, provider design, modality follow-ups
- `docs/discovery/00b-intake-v2.md` — expanded product description, verbatim
- `docs/discovery/04-gap-analysis-intake-v2.md` — what intake v2 changes in the spec
- `docs/discovery/05-interview-round-3.md` — stack, admin surface, architecture questions
- `docs/spec/README.md` — specification v2.0 (index of 16 documents), frozen for build
- `docs/spec/15-phase-plan.md` — whole-system delivery in phases

## Code

- `packages/shared` contracts, `packages/db` schema and migrations, `packages/ai` provider layer and interview engine, `packages/core` server infrastructure, `apps/api` HTTP and SSE API, `apps/worker` jobs, `apps/web` web app, `evals/` engine evals.
- How to run: `docs/RUNNING.md`. Quality gate: `pnpm check`.
