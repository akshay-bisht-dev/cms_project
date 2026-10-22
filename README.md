# IT Services CRM & Workforce Platform (working name: **Orbit**)

A multi-tenant SaaS for IT services companies: employee & HR management, attendance and
time tracking, transparent screenshot monitoring, projects & tasks, CRM, timesheets,
leave, finance, and reporting.

> **Status: Phase 11 (production hardening) complete; all roadmap phases delivered.** Partitioned, retention-managed
> event tables; least-privilege database users (the full browser suite runs on a data-only user); a nonce-based
> CSP; metrics and alert rules; verified backups (a 1.4 M-row restore drill, which found and fixed a defect that
> broke every restore); load-tested reports (p95 < 500 ms); production compose, Nginx TLS and Kubernetes manifests;
> signed-image release and agent-signing pipelines. See the [Phase 11 report](docs/phases/phase-11-hardening.md),
> including the acceptance evidence and what still needs a real environment.

## Design documents

| # | Deliverable | Document |
|---|---|---|
| 1 | System requirements, assumptions, NFRs | [docs/requirements.md](docs/requirements.md) |
| 2 | Functional module matrix | [docs/requirements.md#module-matrix](docs/requirements.md#module-matrix) |
| 3 | System architecture, data flows, decisions & trade-offs | [docs/architecture.md](docs/architecture.md) |
| 4–5 | ER diagrams, MySQL entities, constraints, indexing, retention | [docs/database-design.md](docs/database-design.md) |
| 6 | REST API conventions and module map | [docs/api-reference.md](docs/api-reference.md) |
| 7 | Role-permission matrix | [docs/permissions-matrix.md](docs/permissions-matrix.md) |
| 8 | Frontend route & component map, design tokens | [docs/frontend.md](docs/frontend.md) |
| 9 | JavaScript-only monorepo folder structure | [docs/folder-structure.md](docs/folder-structure.md) |
| 10 | Screenshot capture & storage design | [docs/screenshot-monitoring.md](docs/screenshot-monitoring.md) |
| 11 | Security & privacy architecture | [docs/security-privacy.md](docs/security-privacy.md) |
| 12 | Testing strategy | [docs/testing-strategy.md](docs/testing-strategy.md) |
| 13 | Deployment architecture | [docs/deployment.md](docs/deployment.md) |
| 14 | Phased implementation roadmap | [docs/roadmap.md](docs/roadmap.md) |
| 15 | Environment variables | [docs/environment.md](docs/environment.md) |
| 16 | Docker and production deployment guide | [docs/deployment-guide.md](docs/deployment-guide.md) |
| 17 | Operations: health, metrics, alerts, scheduled jobs, retention | [docs/operations.md](docs/operations.md) |
| 18 | Backup and disaster recovery | [docs/backup-restore.md](docs/backup-restore.md) |
| 19 | Troubleshooting | [docs/troubleshooting.md](docs/troubleshooting.md) |
| 20 | API integration examples, webhooks | [docs/integrations.md](docs/integrations.md) |
| 21 | Performance and load tests | [docs/performance.md](docs/performance.md) |
| 22 | Release checklist | [docs/release-checklist.md](docs/release-checklist.md) |
| 23 | Security checklist | [docs/security-checklist.md](docs/security-checklist.md) |
| 24 | Phase reports | [docs/phases/](docs/phases/) |

## Stack (JavaScript only — no `.ts`/`.tsx` anywhere)

Next.js (App Router, JSX) · Tailwind CSS · shadcn/ui (JSX mode) · TanStack Query · Zustand ·
React Hook Form · Zod · Recharts · Socket.IO · Express 5 · Prisma (`prisma-client-js`) ·
MySQL 8 · Redis · BullMQ · S3-compatible storage · Electron desktop agent · Docker · Nginx ·
GitHub Actions · Vitest · Supertest · Playwright.

## Local setup

Prerequisites: Node.js 24 LTS, pnpm 10 (via corepack), and Docker Desktop or OrbStack.

```bash
sudo corepack enable                 # once: puts pnpm on PATH (version pinned in package.json)
pnpm install
cp .env.example .env                 # dev defaults work as-is

# Infrastructure: MySQL 8.4, Redis 7.4, SeaweedFS (S3), Mailpit
docker compose up -d
#   No Docker? MySQL alone works via: infrastructure/scripts/local-mysql.sh start

pnpm db:migrate                      # apply migrations to the dev database
pnpm db:seed                         # 2 demo orgs × 7 users (owner@, hr@, pm@, lead@, dev1@, dev2@, finance@acme-it.test)

pnpm dev                             # API on :4000, web on :3000 → open http://localhost:3000
pnpm --filter @orbit/api dev:worker  # background worker (needs Redis)
```

| Task | Command |
|---|---|
| API docs (dev) | http://localhost:4000/api/docs · regenerate committed spec: `pnpm --filter @orbit/api openapi` |
| Lint + no-TypeScript guard | `pnpm lint` |
| All tests (unit + integration on `orbit_test`) | `pnpm test` |
| API unit / integration only | `pnpm --filter @orbit/api test:unit` · `test:integration` |
| Real Redis + S3 checks (needs compose stack) | `pnpm --filter @orbit/api test:infra` |
| Browser end-to-end + accessibility (needs MySQL; first run: `pnpm --filter @orbit/web exec playwright install chromium`) | `pnpm --filter @orbit/web test:e2e` |
| Web production build | `pnpm --filter @orbit/web build` |
| Full stack in containers (Nginx on :8080) | `docker compose --profile app up -d --build` |
| Deployment config checks (part of lint) | `node scripts/check-deploy.mjs` |
| Backup / verified restore | `node apps/api/scripts/backup/backup.js` · `restore-verify.js` ([docs/backup-restore.md](docs/backup-restore.md)) |
| Load test / query profile | `apps/api/scripts/perf/*` ([docs/performance.md](docs/performance.md)) |

Behind a TLS-intercepting corporate proxy, set `NODE_USE_SYSTEM_CA=1` so Node (and Prisma's
engine download) trust the macOS keychain.
