# Build from the repository root: docker build -f apps/api/Dockerfile --target api .
# The worker image is the same build with a different command (target: worker).
FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate && apk add --no-cache openssl
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/ai/package.json packages/ai/
COPY packages/db/package.json packages/db/
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY evals/package.json evals/
RUN pnpm install --frozen-lockfile --filter @aidp/api... --filter @aidp/worker... --ignore-scripts
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/worker ./apps/worker
# The root .dockerignore keeps every `.env` out of the build context. This asserts it worked.
# It is here because it already failed once: images were built and run carrying the operator's
# real PLATFORM_ENCRYPTION_KEY and AUTH_SECRET in `apps/api/.env`, which nothing in the build
# noticed and nothing in the running container revealed. An ignore file is a promise; this is
# the check. Secrets arrive at run time from compose `environment:` entries, and nowhere else.
RUN if find . -name '.env' -not -name '.env.example' -not -path '*/node_modules/*' | grep -q .; then \
      echo "refusing to build: a .env reached the build context —" >&2; \
      find . -name '.env' -not -name '.env.example' -not -path '*/node_modules/*' >&2; \
      echo "check the root .dockerignore and that you are building from the repository root" >&2; \
      exit 1; \
    fi
RUN pnpm --filter @aidp/db exec prisma generate \
 && pnpm --filter @aidp/shared build \
 && pnpm --filter @aidp/ai build \
 && pnpm --filter @aidp/db build \
 && pnpm --filter @aidp/core build \
 && pnpm --filter @aidp/api build \
 && pnpm --filter @aidp/worker build

FROM node:22-alpine AS api
# COREPACK_HOME is moved out of /root so the unprivileged runtime user can still resolve pnpm,
# which the compose `migrate` service needs to run `prisma migrate deploy` and the bootstrap seed.
ENV COREPACK_HOME=/opt/corepack
RUN corepack enable \
 && corepack prepare pnpm@10.33.0 --activate \
 && chmod -R a+rX /opt/corepack \
 && apk add --no-cache openssl
WORKDIR /repo
# node:22-alpine ships an unprivileged `node` user (uid 1000). Nothing here writes to the image,
# so the tree stays root-owned and read-only to the process that serves the internet.
COPY --from=build /repo ./
# The one exception: uploaded audio and documents (FR-30, FR-31). Creating the directory here,
# owned by the runtime user, is what makes it writable at run time — Docker seeds a fresh named
# volume from the image's directory, ownership included. A volume mounted over a path that does
# not exist in the image is created root-owned instead, and the unprivileged process cannot write
# to it, which surfaces as every upload failing on a server and working perfectly in development.
RUN mkdir -p /uploads && chown node:node /uploads
ENV NODE_ENV=production HOME=/home/node
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --retries=10 CMD wget -qO- http://127.0.0.1:4000/api/v1/health/ready >/dev/null || exit 1
CMD ["node", "apps/api/dist/server.js"]

FROM api AS worker
HEALTHCHECK NONE
CMD ["node", "apps/worker/dist/main.js"]
