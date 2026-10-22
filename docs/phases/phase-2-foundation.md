# Phase 2 — Foundation (report)

**Date:** 2026-10-21 · **Status:** complete, with two items blocked on Docker (see *Not yet verified*)

## Objective
A working JavaScript-only monorepo that later phases build on: Next.js shell, Express app
factory with the API contract (envelope, errors, request IDs, validation, fail-closed
permissions), Prisma + MySQL with the foundation tables and migrations, background-worker
skeleton, Docker/Nginx/CI configuration, and a test harness on a real database.

## What was built

| Area | Files |
|---|---|
| Workspace | `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `.npmrc`, `.nvmrc`, `eslint.config.mjs`, `scripts/check-no-ts.mjs`, `.env.example` |
| Shared packages | `packages/shared-constants` (error codes, enums), `packages/validation` (Zod shapes: ids, email, password, currency, IANA tz, pagination, sort allow-list), `packages/api-client` (envelope unwrapping, `ApiError`, CSRF header, idempotency header) |
| API core | `src/app.js` (factory, no I/O), `src/server.js` (graceful shutdown), `src/worker.js` (BullMQ worker + Redis-backed scheduler), `config/env.js` (Zod, fail-fast), `config/logger.js` (pino + redaction) |
| API middleware | request ID, request timeout, Zod `validate` (writes to `req.valid`), `authorize` (fails closed until Phase 3), central error handler + 404 |
| Routing | `routes/define-routes.js`: declarative routes. A route without a `permission` throws at startup. A route registry feeds OpenAPI (Phase 3) and route-coverage tests. |
| Health | `GET /api/v1/health/live`, `GET /api/v1/health/ready` (DB `SELECT 1` + migration state, Redis `PING`, S3 `HeadBucket`, each with a 2 s timeout). The 503 response names only the failing dependency. Details stay in logs. |
| Data | `prisma/schema.prisma` with organizations, users, organization_members, user_sessions, audit_logs, outbox_events, idempotency_keys, background_job_records. Migrations `…_init` and `…_audit_logs_append_only` (DB triggers). `prisma.config.mjs`. `prisma/seed.js` (2 orgs + owners, refuses production). |
| Web | Next.js 16 App Router (JSX), Tailwind v4 design tokens, shadcn JSX config + Button/Card/Badge, TanStack Query provider, `/` system-status page, `loading`/`error`/`global-error`/`not-found`, same-origin `/api` rewrite for dev, standalone output |
| Infra | `docker-compose.yml` (MySQL 8.4, Redis 7.4, SeaweedFS S3, Mailpit; `--profile app` adds api/worker/web/nginx), `infrastructure/docker/{api,web}.Dockerfile`, `infrastructure/nginx/conf.d/orbit.conf`, MySQL/Redis config, `infrastructure/scripts/local-mysql.sh` (Docker-free MySQL for dev) |
| CI | `.github/workflows/ci.yml`: lint + no-TS guard, unit tests, web build, integration tests on MySQL service, migration drift check, Docker image builds |

## Database changes
The two migrations above. Constraints proven by tests: UUIDv7 keys, UTC `DATETIME(3)`,
one membership per (org, user), one identity in many orgs, RESTRICT on org deletion,
case-insensitive email uniqueness, and DB-enforced append-only `audit_logs`.

## API contracts added
`GET /api/v1/health/live` (public), `GET /api/v1/health/ready` (public). Every other path
returns the standard 404 envelope. Non-public routes return 401 until Phase 3 adds sessions.

## Verification (actually run on 2026-10-21, macOS x86_64, Node 24.22, MySQL 8.4.10)

| Check | Result |
|---|---|
| `pnpm lint` (ESLint + no-TypeScript guard) | pass, 0 problems |
| API unit tests (`vitest --project unit`) | **21/21 pass** |
| API integration tests on real MySQL (`--project integration`) | **15/15 pass** |
| Web component tests (Vitest + RTL) | **3/3 pass** |
| `pnpm test` (whole workspace) | **39/39 pass** |
| `next build` (standalone) | pass. No `.ts` files generated. |
| `prisma migrate dev` / `validate` | pass |
| `pnpm db:seed` | pass |
| API boot with empty env | exits 1, listing all 7 missing variables |
| Live smoke: API + `next dev` | `/health/live` 200. `/health/ready` 503 with `redis`, `storage` down (expected without Docker). DB up. Request ID propagated through the Next.js rewrite. |

## Not yet verified (needs Docker on this machine)
- `docker compose up`, the Dockerfiles, Nginx routing, and the SeaweedFS healthcheck command are **written but never run**. CI builds the images on its first run.
- The real Redis and S3 clients: `pnpm --filter @orbit/api test:infra` exists but hasn't been run.
- The CI workflow hasn't run either (there's no git remote yet).

## Deviations from the design, and why
| Design said | Implemented | Reason |
|---|---|---|
| `argon2` package | `@node-rs/argon2` | `argon2@0.45` has no Intel-mac prebuild and needs a C toolchain. The napi-rs build ships prebuilds for darwin/linux-musl/windows. |
| MinIO for local S3 | SeaweedFS 4.48 | MinIO images are no longer on Docker Hub |
| Collation `utf8mb4_0900_ai_ci` | `utf8mb4_unicode_ci` | Prisma's MySQL default. Also case-insensitive. Docs updated. |
| Separate `worker.Dockerfile` | One `api.Dockerfile` with `api`/`worker`/`migrate` targets | Same source, no duplicated build stages |
| Test DB recreated per run (`migrate reset`) | `migrate deploy` + per-test cleanup | Non-destructive. Prisma also blocks agent-initiated resets without explicit user consent. |

## Known limitations
- Integration test files run serially on one test DB. Per-worker schemas come when the suite grows (Phase 3).
- No outbox relay yet. The table exists, and the relay ships in Phase 3 with the first events.
- `prisma` CLI is a runtime dependency of the API image, because the `migrate` target needs it.
- Machine-specific: this Mac has a TLS-intercepting proxy, so Node needs `NODE_USE_SYSTEM_CA=1` to download Prisma engines.

## Acceptance criteria
- [x] JS-only monorepo, lockfile, pinned versions, no TypeScript files (enforced)
- [x] Next.js and Express both run
- [x] MySQL migrations and Prisma work, verified by tests on a real DB
- [x] Logging, error envelope, request IDs, health endpoints
- [x] Isolated test DB with a `_test` safety guard
- [ ] `docker compose up` healthy — **pending Docker install**
- [ ] CI green — **pending first push**
