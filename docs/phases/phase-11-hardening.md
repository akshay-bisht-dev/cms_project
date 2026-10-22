# Phase 11: Production hardening (report)

**Date:** 2026-10-22 · **Status:** complete for everything that can run without Docker or a cluster.
Container builds, the compose stack, Kubernetes and the signed agent run first in CI or staging (listed
under Limitations).

## Objective
Production readiness: automated testing, security review, performance, monitoring, backup and restore,
CI/CD and deployment. Acceptance is the brief's §33 list, with evidence (below).

## What was built and fixed
**Data lifecycle**
- Monthly partitions on `activity_events`, `audit_logs`, `screenshot_access_logs` and `login_attempts`
  (migration `…090000`).
- `partition-maintenance` keeps three months ahead and drops expired months. Audit and access-log months
  are first exported to the archive bucket (gzip JSONL, row count and object verified) and are never
  dropped without one.
- It runs as its own database user; Prisma reports no schema drift.
- Retention, promised in the design but not implemented until now, is now enforced.

**Least privilege**
- `scripts/provision-db-users.js` creates five users (app, migrate, maintenance, backup, read-only).
  The app user has data reads and writes only.
- The **full E2E suite passes with the API on that user**. Probes show `TRUNCATE` and `DROP PARTITION`
  denied to it, and the maintenance user can't read other tables.

**Security review**
- **The web app sent no security headers at all.** It now has a per-request nonce CSP with
  `strict-dynamic` (no inline script, no `eval` in production), nosniff, frame denial, referrer and
  permissions policies, and HSTS over HTTPS. E2E asserts the headers and fails on any CSP violation.
- **Rate limits vanished during a Redis outage** (fail-open), allowing unlimited password spraying.
  Counting now falls back to a bounded in-memory store.
- **`deepmerge-ts` advisory** fixed with an override; production dependencies audit clean.
- `.dockerignore` added (`.env*`, `node_modules`, builds and tests were in the build context).
- Backup files are created owner-only.
- Log redaction now has a test; the security checklist was corrected where I had cited tests that
  didn't exist.

**Performance** ([performance.md](../performance.md))
- Volume dataset: ~1.4 M rows. Load generator, query profiler, `performance_schema` review.
- Fixed:
  - an org-wide full scan (new index);
  - unbounded interval queries (`overlapping()`);
  - "today" recomputed for everyone on every read (now reused for a minute, with background refresh
    for large views);
  - a sync budget longer than the request timeout (now time-boxed);
  - an N+1 on time zones (`memberZones`, 3,261 → 23 queries);
  - reports hydrating every person-day (SQL aggregation, randomized SQL-vs-JS equality test).
- Trends: p95 9.2 s → 0.45 s. All endpoints p95 < 500 ms at 10 concurrent users (126 req/s), zero errors.

**Monitoring**
- `/metrics` on an internal port: HTTP latency by route pattern, queues, job failures, outbox lag,
  webhooks, source health.
- 11 Prometheus alert rules, including backup and restore-check freshness.

**Backup and restore** ([backup-restore.md](../backup-restore.md))
- `backup.js`: consistent dump, gzip, optional `age`, S3 upload with verification, manifest.
- `restore-verify.js`: checksum, completeness marker, tables, triggers, migrations, row counts and
  invariants in a scratch database. It fetches from S3 when run elsewhere.
- **Drill:** 1,394,748 rows restored and verified in 100.5 s with zero drift.
- **The drill found that every backup would have failed to restore.** Triggers created by Prisma kept a
  trailing `;` that breaks mysqldump's trigger wrapper. Fixed: migration `…130000` recreates all 15
  triggers as `BEGIN … END` (new before old, so tables are never unprotected), and the restore path
  repairs old dumps. Both paths are verified, with a regression test.

**Deployment**
- `docker-compose.prod.yml`: registry images, only Nginx exposed, read-only, all capabilities dropped,
  internal data network, profiles for release and ops.
- Production Nginx: TLS 1.2/1.3, OCSP stapling, HSTS, edge auth rate limits.
- Kubernetes kustomize base and overlay: restricted Pod Security, HPA and PDBs, NetworkPolicies, ops
  CronJobs, release migration Job, secrets example.
- `ops` image (MySQL 8.4 client tools, Node, `age`).
- `check-deploy.mjs` enforces the hardening rules on every lint run (mutation-tested).

**CI/CD**
- CI: images built and Trivy-scanned (including the ops image's tools); the compose stack runs the real
  Redis/S3 suite; E2E on the least-privilege user; the backup round trip in integration.
- `release.yml`: full CI, signed images with SBOM and provenance, staging, approved production via
  `deploy.sh` (backup → migrate → rollout, automatically undone on failure → smoke test).
- `agent-release.yml`: signed and notarized installers, signatures verified, unsigned builds labelled.
- `security-scan.yml`: ZAP baseline plus a production dependency audit.

**Documentation (completing §30)**
- New: [environment](../environment.md) (completeness tested), [deployment guide](../deployment-guide.md),
  [operations](../operations.md), [backup and DR](../backup-restore.md),
  [troubleshooting](../troubleshooting.md), [performance](../performance.md),
  [security checklist](../security-checklist.md), [release checklist](../release-checklist.md).
- Updated: API integration examples ([integrations.md](../integrations.md)), the
  [testing guide](../testing-strategy.md) (real file names instead of planned ones),
  [deployment.md](../deployment.md) and [database-design.md](../database-design.md), which had claimed
  Sentry, a queue UI, replica reads and a 15-minute RPO that were not built. They now say so.

## Verification (run 2026-10-22)
| Check | Result |
|---|---|
| Lint, no-TypeScript guard, deployment checks | pass |
| API unit | **119/119** (+ partitions, environment docs, log redaction, rate-limit fallback and bounds) |
| API integration (real MySQL) | **1,403/1,403** (+ partitions 3, metrics 2, stats scaling 5, backup 4) |
| Web unit · desktop agent | **20/20** · **34/34** |
| Playwright E2E + axe + CSP watch | **32/32**, API on the DML-only database user |
| Load test | p95 334 ms / p99 414 ms at 10 users, 126 req/s, 0 errors ([evidence](../evidence/phase-11/)) |
| Restore drill | 1,394,748 rows, 100.5 s, zero drift, invariants ok ([evidence](../evidence/phase-11/restore-drill.json)) |
| Migrations | 14 applied to dev, E2E and perf databases; `prisma migrate diff`: no difference |
| Dependency audit | `pnpm audit --prod`: no known vulnerabilities |

## §33 acceptance criteria
| Criterion | Status | Evidence |
|---|---|---|
| Frontend runs using JavaScript | ✅ | `next build`; E2E on the production build; no-TS guard |
| Express backend runs using JavaScript | ✅ | E2E; load test with `NODE_ENV=production` |
| MySQL migrations and Prisma work | ✅ | 14 migrations deployed to three databases; drift check clean; restore re-checks migration checksums |
| Authentication and permissions enforced | ✅ | Generated suite over all 327 operations; E2E across roles |
| Organization data isolated | ✅ | `tenant-isolation.test.js`, tenant guard, client and API-key isolation on every route |
| Employee management end to end | ✅ | `people.spec.js`, `employees.test.js` |
| Attendance and timers persist | ✅ | `time.spec.js` (timer survives reload), `work.test.js` |
| Timesheets: submission and approval | ✅ | `time.spec.js`, `timesheets.test.js` |
| Screenshot capture through an authorized mechanism | 🟡 | Consent-gated API and agent logic tested (`monitoring.test.js`, agent tests, `monitoring.spec.js`); **the Electron agent has not captured on a real desktop** (needs a desktop and OS permission) |
| Screenshots secure, visible only to authorized users | ✅ / 🟡 | Private storage, 60 s signed URLs, access logs, permission tests; real S3 runs in CI's compose job |
| Project and task workflows | ✅ | `projects.spec.js`, `projects.test.js` |
| Client CRM workflows | ✅ | `crm-finance.spec.js`, `crm.test.js` |
| Leave requests and approvals | ✅ | `hr-integrations.spec.js`, `leave.test.js` |
| Financial records and reports consistent | ✅ | `finance.test.js` (PAID only from payments, concurrency), SQL-vs-JS report equality, restore invariants |
| Dashboard metrics from real records | ✅ | Dashboard and report tests; nothing hardcoded; measured/derived/estimated labels |
| Exports work and enforce permissions | ✅ | `activity-reports.test.js` (download re-checks permission), `reports.spec.js` |
| Audit logging covers sensitive actions | ✅ | Audited actions asserted across module tests; audit page E2E; append-only trigger; archived before retention |
| Background jobs retry safely | ✅ / 🟡 | Outbox, webhook retries, idempotent accruals and partitions tested as functions; BullMQ on real Redis runs only in CI |
| Automated tests cover critical workflows | ✅ | 1,608 automated tests across five suites ([testing guide](../testing-strategy.md)) |
| Docker deployment works | 🟡 | Images, compose and manifests written and statically enforced; CI builds, scans and runs the compose stack. **Not run here: no Docker available** |
| Production environment variables documented | ✅ | [environment.md](../environment.md); a test fails on any undocumented variable |
| Backups can be restored | ✅ | Drill with evidence; round-trip test in CI; restore defect found and fixed |
| Security, privacy and retention controls | ✅ | [security-checklist.md](../security-checklist.md); retention enforced; CSP; least privilege |
| No critical defects in primary workflows | ✅ (known) | Every suite green; the critical defects this phase found (restore, missing CSP, fail-open limits) are fixed and tested. An external penetration test is still recommended |

## Bugs found and fixed this phase
1. **Every logical backup failed to restore** (trigger bodies with a trailing `;`). Migration plus restore repair.
2. **The web app sent no security headers.** Nonce CSP and headers added.
3. **Rate limits disappeared while Redis was down.** In-memory fallback, now bounded.
4. **Retention was never enforced** for activity, audit, access and login logs. Partitions and maintenance added.
5. **Reports and dashboards degraded with organization size:** a full scan, unbounded intervals,
   recompute-on-read, an N+1 query, and a sync budget longer than the timeout.
6. **My own mistakes, caught by checks:**
   - an empty migration recorded as failed in local databases (resolved, regenerated, deployed);
   - a time budget I added that broke the background backfill (fixed, with a test);
   - the perf generator's task dates (corrected; the earlier calendar timing was an artifact);
   - a compose network layout that would have cut the app off from managed databases;
   - checker false positives (YAML merge keys);
   - a few test-expectation errors.
7. **Operational details:**
   - `MYSQL_PWD` was overridden by a user's `~/.my.cnf` and `localhost` used a socket; scripts now use a
     private `--defaults-file` with TCP;
   - backup files were world-readable;
   - restore-verify couldn't see the backup from another pod (it now fetches from S3).

## Limitations
- **Not run in this environment:** Docker builds, the production compose file, Kubernetes, Nginx `-t`,
  Trivy, cosign, ZAP, and the release and agent workflows. Each is written, statically checked where
  possible, and runs first in CI or staging.
- **Not built:**
  - Sentry/error tracking and tracing;
  - read-replica reporting;
  - a queue admin UI;
  - binary-log shipping for self-hosted point-in-time recovery (use managed MySQL);
  - per-organization audit retention (partition drops are global).
- **Desktop agent:** real-desktop capture and signed installers need a desktop and purchased certificates.
- **Remaining latency:** dashboard, calendar and projects stay at 150–300 ms on very large projects
  (Prisma relation-filter SQL); fine at expected sizes ([performance.md](../performance.md)).
- **Before the first customer:** a staging rehearsal of the deployment guide and an external penetration test.
