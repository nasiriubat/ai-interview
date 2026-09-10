# Working in this repository

This file is for coding agents and new engineers. It is the short version of
`docs/spec/10-architecture.md` and `docs/team/roles.md`.

## Ground rules

1. **The spec is the contract.** `docs/spec/` is frozen; changes go through `docs/discovery/decisions.md` first. Requirement ids (`FR-`, `NFR-`, `ADM-`) appear in commit messages and tests.
2. **No model call outside `ModelCaller`.** Routing, budgets, and the ledger live there (`packages/ai/src/callModel.ts`). Adapters live only in `packages/ai/src/providers/`.
3. **Templates and settings are data.** New interview behavior is a template field or a settings-catalog key (`packages/shared/src/settings.ts`), not a constant.
4. **Every tenant-owned query goes through the scoped client** (`forCompany`) or is filtered by `companyId` explicitly; RLS is the second fence, not the first.
5. **Ports and adapters** at every external edge, each with an in-memory fake. Tests never hit the network.
6. **Prompts are versioned files** in `packages/ai/src/engine/prompts/`. A prompt change bumps the version and runs `pnpm --filter @aidp/evals test`.
7. **Quality gate before every push:** `pnpm check` (build, typecheck, lint, tests). Integration tests need `DATABASE_URL` pointing at a migrated Postgres with pgvector.

## Layout

| Path | Owns |
|---|---|
| `packages/shared` | Zod contracts: purposes, providers, chat, widgets, facts, templates, session state, settings catalog |
| `packages/db` | Prisma schema, migrations, scoped client, shipped templates, seeds and bootstrap |
| `packages/ai` | Provider adapters, cost control, the interview engine, extraction, summary, prompts |
| `packages/core` | Server infrastructure shared by API and worker: crypto, settings service, Prisma adapters, engine factory, jobs, email |
| `apps/api` | Fastify HTTP and SSE API, one folder per module under `src/modules/` with `service.ts` (logic) and `routes.ts` (transport) |
| `apps/worker` | pg-boss consumers |
| `apps/web` | Next.js app: participant flow, admin, requirements workspace |
| `evals` | Deterministic engine replays; model-backed evals later |

## Conventions

- TypeScript strict with `exactOptionalPropertyTypes`; build partial objects with spreads or `defined()` rather than passing `undefined`.
- Route handlers validate with zod schemas and return plain objects; services throw `AppError` with a code from `apps/api/src/lib/errors.ts`.
- Admin actions write to the audit log.
- Commit messages say what changed and why, referencing requirement ids where they apply.
