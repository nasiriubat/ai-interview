# Running the platform locally

Prerequisites: Node 22, pnpm 10, Docker.

```bash
docker compose up -d postgres            # Postgres 16 with pgvector on localhost:5432
pnpm install
pnpm -r build
cp apps/api/.env.example apps/api/.env   # fill PLATFORM_ENCRYPTION_KEY (openssl rand -base64 32) and AUTH_SECRET
export DATABASE_URL=postgresql://app:app@localhost:5432/ai_discovery
pnpm --filter @aidp/db migrate:deploy
BOOTSTRAP_OPERATOR_EMAIL=you@example.com BOOTSTRAP_ADMIN_EMAIL=you@example.com \
  PLATFORM_ENCRYPTION_KEY=<same as .env> ANTHROPIC_API_KEY=sk-ant-... \
  pnpm --filter @aidp/db bootstrap
pnpm --filter @aidp/api dev              # API on http://localhost:4000, OpenAPI at /api/v1/openapi.json
pnpm --filter @aidp/worker dev
pnpm --filter @aidp/web dev              # web app on http://localhost:3000
```

Checks: `pnpm check` runs build, typecheck, lint, and tests. Integration tests need `DATABASE_URL`.

Provider configuration without an Anthropic key: sign in as the operator, add a provider
(OpenAI, OpenRouter, LiteLLM, or any OpenAI-compatible server), fetch its models, and set
routes per purpose. Nothing works until `interview_turn` has a route.
