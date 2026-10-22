# syntax=docker/dockerfile:1.7
# Builds the API and the worker from one source tree (they share services and repositories).
#   docker build -f infrastructure/docker/api.Dockerfile --target api .
#   docker build -f infrastructure/docker/api.Dockerfile --target worker .

FROM node:24-alpine AS base
RUN apk add --no-cache openssl tini && corepack enable
WORKDIR /repo

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY packages/shared-constants/package.json packages/shared-constants/
COPY packages/validation/package.json packages/validation/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "@orbit/api..."
COPY packages/shared-constants packages/shared-constants
COPY packages/validation packages/validation
COPY apps/api apps/api
# Produce a self-contained production install, then generate the Prisma client for this platform (musl).
RUN pnpm --filter @orbit/api deploy --prod --legacy /out \
 && cd /out && ./node_modules/.bin/prisma generate

FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Runtime images start node directly: package managers are build-time tools. Removing the copies
# bundled with the base image (npm, npx, corepack/pnpm, yarn) drops their dependencies (and their
# advisories) from what ships.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
  /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/pnpm /usr/local/bin/pnpx \
  /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --from=build --chown=node:node /out ./
USER node
ENTRYPOINT ["/sbin/tini", "--"]

FROM runtime AS api
ENV ORBIT_SERVICE=api PORT=4000
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s \
  CMD wget -q -O /dev/null http://127.0.0.1:4000/api/v1/health/live || exit 1
CMD ["node", "src/server.js"]

FROM runtime AS worker
ENV ORBIT_SERVICE=worker
CMD ["node", "src/worker.js"]

# Release-time migration job (run manually / from the release pipeline, never on app start).
FROM runtime AS migrate
CMD ["./node_modules/.bin/prisma", "migrate", "deploy"]

# Operations jobs: backups, restore verification, partition maintenance, user provisioning.
# Based on the official MySQL image for matching mysqldump/mysql clients (Alpine only ships MariaDB's);
# Node comes from the official image, and the Prisma engine is generated here for this platform.
#   docker build -f infrastructure/docker/api.Dockerfile --target ops -t orbit-ops .
#   docker run --rm --env-file ops.env orbit-ops node scripts/backup/backup.js
# age (backup encryption) from Debian's signed repositories; it is a static Go binary.
FROM debian:bookworm-slim AS age
RUN apt-get update && apt-get install -y --no-install-recommends age && rm -rf /var/lib/apt/lists/*

FROM mysql:8.4 AS ops
COPY --from=node:24-bookworm-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=age /usr/bin/age /usr/bin/age-keygen /usr/local/bin/
COPY --from=build --chown=mysql:mysql /out /app
WORKDIR /app
RUN ./node_modules/.bin/prisma generate && mkdir -p /app/backups && chown mysql:mysql /app/backups
USER mysql
ENV NODE_ENV=production BACKUP_DIR=/app/backups
ENTRYPOINT []
CMD ["node", "scripts/backup/backup.js"]
