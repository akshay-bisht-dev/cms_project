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
# A minimal Oracle Linux 9 with only MySQL's official client package (matching mysql/mysqldump; Alpine
# only ships MariaDB's), Node from the official image, and age built from source. The MySQL *server*
# image is deliberately not used: it bundles MySQL Shell's Python runtime and gosu, which the jobs never
# need and which carry their own advisories.
#   docker build -f infrastructure/docker/api.Dockerfile --target ops -t orbit-ops .
#   docker run --rm --env-file ops.env orbit-ops node scripts/backup/backup.js

# age (backup encryption), statically built with a current Go toolchain. Its Go dependencies are raised
# to their latest patch releases; age's own go.mod would otherwise pin older versions.
FROM golang:1.26-alpine AS age
WORKDIR /src
RUN go mod init build \
 && go get filippo.io/age@v1.2.1 golang.org/x/crypto@latest golang.org/x/sys@latest golang.org/x/term@latest \
 && CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/age filippo.io/age/cmd/age \
 && CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/age-keygen filippo.io/age/cmd/age-keygen

FROM oraclelinux:9-slim AS ops
# MySQL's repository package installs the repo and its GPG key; packages are signature-checked.
RUN rpm -Uvh https://repo.mysql.com/mysql84-community-release-el9-2.noarch.rpm \
 && microdnf install -y --nodocs mysql-community-client libstdc++ \
 && microdnf clean all \
 && echo 'ops:x:999:999:Orbit ops jobs:/app:/sbin/nologin' >> /etc/passwd \
 && echo 'ops:x:999:' >> /etc/group
COPY --from=node:24-bookworm-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=age /out/age /out/age-keygen /usr/local/bin/
COPY --from=build --chown=999:999 /out /app
WORKDIR /app
# Generates the Prisma engine for this platform (rhel-openssl-3.0.x).
RUN ./node_modules/.bin/prisma generate && mkdir -p /app/backups && chown 999:999 /app/backups
USER 999:999
ENV NODE_ENV=production BACKUP_DIR=/app/backups
CMD ["node", "scripts/backup/backup.js"]
