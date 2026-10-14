# syntax=docker/dockerfile:1.7
#
# Build from the repository root: docker build -f apps/web/Dockerfile -t aidp-web .
#
# The same base as the server image (apps/api/Dockerfile), on purpose: Docker stores a layer once
# however many images use it, so the Debian and Node.js layers under both are one copy on the VPS,
# one download on deploy, and one base to keep patched. On Alpine they were two of each.
FROM node:22-bookworm-slim AS base
ENV npm_config_store_dir=/pnpm/store
# pnpm 10.34.7: 10.33.0 carries advisories the Trivy image scan fails on (D-267).
RUN corepack enable && corepack prepare pnpm@10.34.7 --activate
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
# pnpm refuses to install when patchedDependencies names a file it cannot find.
COPY tools/patches tools/patches
COPY packages/shared/package.json packages/shared/
COPY packages/ai/package.json packages/ai/
COPY packages/db/package.json packages/db/
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY tools/evals/package.json tools/evals/
RUN --mount=type=cache,id=aidp-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @aidp/web... --ignore-scripts

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
# `next build` type-checks everything the tsconfig includes, and e2e/fixtures.ts reads the shipped
# template JSON from packages/db. Without these files the image does not build (found by the
# Security M3 image scan and again by the full-stack drill; it had not been built since the e2e harness landed).
COPY packages/db/src/seed-templates packages/db/src/seed-templates
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
# The live voice socket is the one URL the browser opens itself, so it has to be in the client
# bundle, and Next inlines NEXT_PUBLIC_* at build time rather than reading it at run time. Empty
# is the right default: the browser then uses its own origin, which is correct behind Caddy.
# Development builds pass the API's own address, because there the two are on different ports.
ARG NEXT_PUBLIC_VOICE_WS_URL=""
ENV NEXT_PUBLIC_VOICE_WS_URL=$NEXT_PUBLIC_VOICE_WS_URL
RUN pnpm --filter @aidp/shared build && pnpm --filter @aidp/web build

FROM node:22-bookworm-slim AS runner
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
# Security patches published since the base image was built, and no npm: nothing here installs
# packages at run time, and the npm that ships in the Node image carries its own advisories
# (found by the Trivy image scan, D-267).
RUN apt-get update \
 && apt-get -y --no-install-recommends upgrade \
 && rm -rf /var/lib/apt/lists/* /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
WORKDIR /app
# Root-owned and read-only to the process, like the server image; it runs as the image's own
# unprivileged `node` user (uid 1000). Nothing here writes to disk at run time.
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public
# The one writable place: Next keeps its runtime cache (image optimisation, fetch cache) here.
RUN mkdir -p apps/web/.next/cache && chown node:node apps/web/.next/cache
USER node
EXPOSE 3000
# A route that touches nothing but the process (app/api/health); `node` rather than wget, which
# the slim image does not carry.
HEALTHCHECK --interval=30s --timeout=5s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/web/server.js"]
