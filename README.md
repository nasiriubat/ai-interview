# AIScope

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

- How to run: `docs/RUNNING.md`. Deploying to a server: `docs/DEPLOY.md`. Quality gate: `pnpm check`.

### Repository layout

| Folder      | What is in it                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------ |
| `apps/`     | The deployables: `api` (Fastify HTTP and SSE), `worker` (pg-boss jobs), `web` (Next.js)          |
| `packages/` | Shared libraries: `shared` contracts, `db` schema and migrations, `ai` engine, `core`, `testing` |
| `deploy/`   | The production stack and the operator's commands; `deploy/README.md` lists each one              |
| `docs/`     | Discovery, the frozen spec, decisions, runbooks (`RUNNING`, `DEPLOY`, `OPERATIONS`)              |
| `tools/`    | Tooling: evals, live-run, load tests, rehearsal stack, fake provider, lint rules, pnpm patches   |
| `scripts/`  | Repository scripts: `pnpm check`, the env-file loader and migration, security gates              |
| `.github/`  | CI workflows, CODEOWNERS, and the security-scan configuration in `.github/security/`             |

### Configuration

The repository has one configuration file: the root `.env`. `.env.example` documents every
variable, for development and production, in labelled sections (required everywhere, required for
production only, optional, development defaults). In development, copy it; `docker compose`, the
API, the worker, the database tools and `next dev` all read it (see
[docs/RUNNING.md](docs/RUNNING.md#configuration) for precedence and the admin overrides). An older
`apps/api/.env` is still read underneath it until `pnpm env:migrate` moves it. In production,
`deploy/generate-env.sh` writes the same root `.env` with fresh secrets, `deploy/dc` and the other
deploy scripts pass it to compose, and `deploy/compose.yml` names every variable explicitly.
