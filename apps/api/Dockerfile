# syntax=docker/dockerfile:1.7
#
# The server image: one build, three jobs. `migrate`, `api` and `worker` all run this image and
# differ only in their command (D-74), so a machine holds one copy of it instead of three
# identical 900 MB ones under three names.
#
#   docker build -f apps/api/Dockerfile -t aidp-server .        # from the repository root
#
# Debian-slim rather than Alpine: the ONNX runtime behind local transcription (D-75) ships glibc
# builds only, and Prisma's engines are happier there too.
FROM node:22-bookworm-slim AS base
# COREPACK_HOME is moved out of /root so the unprivileged runtime user can still resolve pnpm,
# which the `migrate` command needs to run `prisma migrate deploy` and the bootstrap seed.
ENV COREPACK_HOME=/opt/corepack npm_config_store_dir=/pnpm/store
# Patches published since the base image was built are applied (`upgrade`), and npm is removed:
# nothing here installs with it, it carries advisories of its own, and pnpm is the tool that is
# used. pnpm 10.34.7 because 10.33.0 fails the Trivy image scan (D-267).
RUN corepack enable \
 && corepack prepare pnpm@10.34.7 --activate \
 && chmod -R a+rX /opt/corepack \
 && apt-get update \
 && apt-get -y --no-install-recommends upgrade \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/* /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
WORKDIR /repo

# Manifests only, so a source change does not invalidate the dependency layers below.
FROM base AS manifests
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
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

# Everything needed to compile: TypeScript, Prisma's generator, the lot. None of it ships.
FROM manifests AS build
RUN --mount=type=cache,id=aidp-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @aidp/api... --filter @aidp/worker... --ignore-scripts
COPY scripts/with-lock.mjs ./scripts/with-lock.mjs
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/worker ./apps/worker
# The root .dockerignore keeps every `.env` out of the build context. This asserts it worked.
# It is here because it already failed once: images were built and run carrying the operator's
# real PLATFORM_ENCRYPTION_KEY and AUTH_SECRET in `apps/api/.env` (now the root `.env`), which nothing in the build
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
 && pnpm --filter @aidp/db build:seeds \
 && pnpm --filter @aidp/api build \
 && pnpm --filter @aidp/worker build

# Production dependencies only. Install scripts run here (unlike the build stage) because Prisma's
# engines arrive through them, and the runtime user cannot download them later into a read-only
# tree. `onlyBuiltDependencies` in pnpm-workspace.yaml limits which packages may run scripts.
FROM manifests AS prod-deps
RUN --mount=type=cache,id=aidp-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter @aidp/api... --filter @aidp/worker...
COPY packages/db/prisma packages/db/prisma
# Then drop what no production process reads, about 190 MB uncompressed: source maps and type
# declarations inside dependencies, and Prisma's WebAssembly engines, which serve only the edge
# and driver-adapter runtimes. This schema uses the native library engine (no `driverAdapters`
# preview, no `engineType`); adding either means keeping the `.wasm-base64` files again.
#
# The speech runtime (D-75) is the other large one. onnxruntime-node ships native builds for macOS,
# Windows and both Linux architectures, about 290 MB, and a Linux container loads exactly one of
# them; onnxruntime-web's WebAssembly engines (about 110 MB) serve browsers, never Node, which runs
# the native build. Both packages stay installed, because transformers.js imports them by name.
RUN pnpm --filter @aidp/db exec prisma generate \
 && find node_modules/.pnpm -type f \
      \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' -o -name '*.wasm-base64.*' \) \
      -delete \
 && case "$(uname -m)" in aarch64|arm64) keep=arm64 ;; *) keep=x64 ;; esac \
 && for bin in node_modules/.pnpm/onnxruntime-node@*/node_modules/onnxruntime-node/bin/napi-v*; do \
      [ -d "$bin" ] || continue; \
      find "$bin" -mindepth 1 -maxdepth 1 -type d ! -name linux -exec rm -rf {} +; \
      find "$bin/linux" -mindepth 1 -maxdepth 1 -type d ! -name "$keep" -exec rm -rf {} +; \
    done \
 && find node_modules/.pnpm -path '*onnxruntime-web*/dist/*' -name '*.wasm' -delete

FROM base AS server
COPY --from=prod-deps /repo ./
COPY --from=build /repo/packages/shared/dist packages/shared/dist
COPY --from=build /repo/packages/ai/dist packages/ai/dist
COPY --from=build /repo/packages/db/dist packages/db/dist
COPY --from=build /repo/packages/db/dist-seeds packages/db/dist-seeds
COPY --from=build /repo/packages/core/dist packages/core/dist
COPY --from=build /repo/apps/api/dist apps/api/dist
COPY --from=build /repo/apps/worker/dist apps/worker/dist
# Uploaded audio and documents (FR-30, FR-31), and the downloaded speech model (D-75). Creating
# the directories here, owned by the runtime user, is what makes them writable at run time —
# Docker seeds a fresh named volume from the image's directory, ownership included. A volume
# mounted over a path that does not exist in the image is created root-owned instead, and the
# unprivileged process cannot write to it, which surfaces as every upload failing on a server
# and working perfectly in development.
RUN mkdir -p /uploads /models && chown node:node /uploads /models
# The official image ships an unprivileged `node` user (uid 1000). Nothing else here writes to
# the image, so the tree stays root-owned and read-only to the process that serves the internet.
ENV NODE_ENV=production HOME=/home/node
USER node
EXPOSE 4000
# The API's check. The worker and the one-shot migrate run the same image and set their own in
# compose (a worker has no HTTP surface). `node` rather than wget: slim images carry neither.
HEALTHCHECK --interval=15s --timeout=5s --retries=10 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4000/api/v1/health/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/api/dist/server.js"]
