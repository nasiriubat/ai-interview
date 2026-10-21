# Working in this repository

This file is for coding agents and new engineers. It is the short version of
`docs/spec/10-architecture.md` and `docs/team/roles.md`.

## Ground rules

1. **The spec is the contract.** `docs/spec/` is frozen; changes go through `docs/discovery/decisions.md` first. Requirement ids (`FR-`, `NFR-`, `ADM-`) appear in commit messages and tests.
2. **No model call outside `ModelCaller`.** Routing, budgets, and the ledger live there (`packages/ai/src/callModel.ts`). Adapters live only in `packages/ai/src/providers/`.
3. **Templates and settings are data.** New interview behavior is a template field or a settings-catalog key (`packages/shared/src/settings.ts`), not a constant.
4. **Every tenant-owned query goes through the scoped client** (`forCompany`) or is filtered by `companyId` explicitly; RLS is the second fence, not the first.
5. **Ports and adapters** at every external edge, each with an in-memory fake. Tests never hit the network.
6. **Prompts are versioned files** in `packages/ai/src/engine/prompts/`. A prompt change bumps the version and runs `pnpm --filter @aidp/evals test`. A tenant may add versions (`key@tN`) through the admin; they must keep the contract in `engine/prompts/admin.ts` and are never edited in place.
7. **Quality gate before every push:** `pnpm check` (format, build, typecheck, lint, tests). It needs `DATABASE_URL` pointing at a migrated Postgres with pgvector (`pnpm db:up`) and fails without it. `pnpm check --no-db` runs the rest and prints a banner that the result is not the gate. A skipped test with a database present fails the run. Database suites use `describeDb` from `@aidp/testing`, never `describe.skip`.

## Layout

| Path               | Owns                                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared`  | Zod contracts: purposes, providers, chat, widgets, facts, templates, session state, settings catalog                       |
| `packages/db`      | Prisma schema, migrations, scoped client, shipped templates, seeds and bootstrap                                           |
| `packages/ai`      | Provider adapters, cost control, the interview engine, extraction, summary, prompts                                        |
| `packages/core`    | Server infrastructure shared by API and worker: crypto, settings service, Prisma adapters, engine factory, jobs, email     |
| `apps/api`         | Fastify HTTP and SSE API, one folder per module under `src/modules/` with `service.ts` (logic) and `routes.ts` (transport) |
| `apps/worker`      | pg-boss consumers                                                                                                          |
| `apps/web`         | Next.js app: participant flow, admin, requirements workspace                                                               |
| `packages/testing` | Dev-only fakes and gates: `MemorySessionStore`, `ScriptedModel`, `describeDb`, the network guard                           |
| `deploy`           | Production stack (`compose.yml`, `Caddyfile`) and operator commands; `backup/`, `lib/`, `ops/`, `observability/`, `test/`  |
| `tools`            | `evals`, `live-run`, `report-bench`, `load` (k6), `rehearsal` (drill, chaos), `fake-provider`, `eslint-rules`, `patches`   |
| `scripts`          | Repository scripts: `check.ts` (the gate), env-file loader and `env:migrate`, security and migration gates                 |

## Conventions

- TypeScript strict with `exactOptionalPropertyTypes`; build partial objects with spreads or `defined()` rather than passing `undefined`.
- Route handlers validate with zod schemas and return plain objects; services throw `AppError` with a code from `apps/api/src/lib/errors.ts`.
- Admin actions write to the audit log.
- One env file: the repository-root `.env`, for development and production alike; `.env.example` documents every key (D-450). Add a new variable there, in its section.
- Commit messages say what changed and why, referencing requirement ids where they apply.
