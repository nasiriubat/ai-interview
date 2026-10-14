# syntax=docker/dockerfile:1.7
#
# The fake model provider (tools/fake-provider): an OpenAI-compatible server with scripted,
# deterministic behaviour, for load tests, chaos drills and the full-stack drill. It is never part
# of a production deployment; deploy/compose.fake.yml adds it for the rehearsal.
#
#   docker build -f tools/fake-provider/Dockerfile -t aidp-fake-provider .   # from the repository root
#
# No runtime dependencies at all, so the final image is Node and about 100 KB of JavaScript.
# TypeScript is installed in a throwaway stage with its own manifest: the workspace manifest names
# `workspace:*` packages that are not in this build context.
FROM node:22-alpine AS build
WORKDIR /src
RUN npm init -y >/dev/null && npm install --no-audit --no-fund typescript@5.9 @types/node@22
COPY tsconfig.base.json ./
COPY tools/fake-provider/tsconfig.build.json tools/fake-provider/
COPY tools/fake-provider/src tools/fake-provider/src
RUN printf '{"type":"module"}' > package.json \
 && cd tools/fake-provider && printf '{"type":"module"}' > package.json \
 && ln -s /src/node_modules node_modules \
 && /src/node_modules/.bin/tsc -p tsconfig.build.json

FROM node:22-alpine
ENV NODE_ENV=production PORT=4010 HOST=0.0.0.0
WORKDIR /app
COPY --from=build /src/tools/fake-provider/dist ./dist
RUN printf '{"type":"module"}' > package.json
USER node
EXPOSE 4010
HEALTHCHECK --interval=5s --timeout=3s --retries=10 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4010/__health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
