# Build from the repository root: docker build -f apps/web/Dockerfile .
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/ai/package.json packages/ai/
COPY packages/db/package.json packages/db/
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY evals/package.json evals/
RUN pnpm install --frozen-lockfile --filter @aidp/web... --ignore-scripts

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
# Same assertion as apps/api/Dockerfile, for the same reason: the root .dockerignore keeps every
# `.env` out of the build context, and this is the check that it did. The final image copies only
# the standalone output, so a leak here would sit in a build layer rather than in the shipped
# image — still not somewhere secrets belong.
RUN if find . -name '.env' -not -name '.env.example' -not -path '*/node_modules/*' | grep -q .; then \
      echo "refusing to build: a .env reached the build context —" >&2; \
      find . -name '.env' -not -name '.env.example' -not -path '*/node_modules/*' >&2; \
      echo "check the root .dockerignore and that you are building from the repository root" >&2; \
      exit 1; \
    fi
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @aidp/shared build && pnpm --filter @aidp/web build

FROM node:22-alpine AS runner
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /repo/apps/web/.next/standalone ./
COPY --from=build --chown=app:app /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=app:app /repo/apps/web/public ./apps/web/public
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/ >/dev/null || exit 1
CMD ["node", "apps/web/server.js"]
