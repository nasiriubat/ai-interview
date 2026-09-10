# Build once, run the API. The worker image uses the same build stage.
FROM node:22-alpine AS build
RUN corepack enable && apk add --no-cache openssl
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/worker ./apps/worker
RUN pnpm install --frozen-lockfile && pnpm -r build && pnpm --filter @aidp/db exec prisma generate

FROM node:22-alpine AS api
RUN apk add --no-cache openssl
WORKDIR /repo
COPY --from=build /repo ./
ENV NODE_ENV=production
EXPOSE 4000
CMD ["node", "apps/api/dist/server.js"]

FROM api AS worker
CMD ["node", "apps/worker/dist/main.js"]
