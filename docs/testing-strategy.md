# Testing guide

What is tested, where, and how to run it. Results are always reported from real runs, never assumed.
(Phase 1 planned this; Phase 11 replaced the planned file names with the real ones.)

## 1. Suites
| Suite | Tool | Command | What it covers |
|---|---|---|---|
| API unit | Vitest | `pnpm --filter @orbit/api test:unit` | Pure logic: time zones, DST, overnight work dates, money (half-even), KPIs, leave days, rate limits, partition planning, webhook signatures, SSRF guard, crypto, TOTP, log redaction, environment docs |
| API integration | Vitest + Supertest, **real MySQL 8.4** (`orbit_test`) | `pnpm --filter @orbit/api test:integration` | Every module through HTTP, plus the generated permission suite (see below), tenant isolation, OpenAPI drift, partition maintenance, metrics, stats scaling, backup → restore → verify round trip |
| Real infrastructure | Vitest, docker compose (Redis, SeaweedFS) | `pnpm --filter @orbit/api test:infra` | Readiness against the real Redis and S3 clients |
| Web unit | Vitest + Testing Library | `pnpm --filter @orbit/web test` | Sign-in flow, sidebar permission gating, profile tabs, time-zone display, CSP builder |
| Desktop agent | Vitest | `pnpm --filter @orbit/desktop-agent test` | Scheduler, local queue, uploader, authentication; Electron modules mocked |
| Browser E2E + accessibility | Playwright + axe | `pnpm --filter @orbit/web test:e2e` | Journeys across roles (`apps/web/e2e/*.spec.js`) on a production build; axe (WCAG 2.2 AA, serious/critical fail); **any CSP violation fails**; security headers asserted |
| Deployment config | `scripts/check-deploy.mjs` | `pnpm lint` | Compose, Kubernetes, workflow hardening rules |
| Load and query review | `apps/api/scripts/perf/*` | see [performance.md](performance.md) | p95 budget, N+1 detection, slow statements |
| Security | Trivy (images), `pnpm audit --prod`, OWASP ZAP baseline (staging) | CI, `security-scan.yml` | Known vulnerabilities, passive DAST |

**Safety rule:** test databases must end in `_test` (`_e2e_test`, `_perf_test`); configuration and the
helpers refuse anything else, so destructive tests can never reach a real database.

## 2. The generated permission suite
`tests/integration/permissions.generated.test.js` reads the route registry and, for **every** operation
(327), asserts: 401 without credentials; 403 for a member without the permission; agent tokens refused
on non-agent routes; client-portal users refused on internal routes; API keys refused on routes not
declared `apiKey`. A new route is covered the moment it is declared.

## 3. Mandatory cases → where they live
| Case | Tests |
|---|---|
| Valid/invalid login, lockout, MFA | `auth.test.js`, `mfa.test.js` |
| Expired / revoked sessions (also on sockets) | `auth.test.js`, `notifications.test.js` |
| Permission-denied operations | `permissions.generated.test.js` (every route) |
| Cross-organization access | `tenant-isolation.test.js`, composite FKs in `schema.test.js` |
| Duplicate clock-in, including concurrent requests | `work.test.js` |
| Overlapping work sessions and time entries | `work.test.js`, `attendance.test.js`, `timesheets.test.js` |
| Timer recovery after reload | `work.test.js`, E2E `time.spec.js` |
| Overnight shifts, DST transitions | `unit/time.test.js`, `work.test.js`, `attendance.test.js` |
| Manual time corrections and revisions | `timesheets.test.js`, `attendance.test.js` |
| Timesheet approve/reject/resubmit, double counting | `timesheets.test.js` |
| Duplicate screenshot uploads, unauthorized access, retention, legal hold | `monitoring.test.js` |
| Upload failure and retry | `desktop-agent/tests/agent.test.js`, `local-queue.test.js`, `monitoring.test.js` |
| Leave balances, half days, overlap (concurrent) | `unit/leave-days.test.js`, `leave.test.js` |
| Concurrent updates (version conflicts, deadlock retry) | `unit/tx.test.js`, `timesheets.test.js`, `finance.test.js` |
| Background-job retries and idempotency | `outbox.test.js`, `integrations.test.js` (webhook retries), `partitions.test.js` |
| Invoice calculations; PAID only from payments | `unit/money.test.js`, `finance.test.js` |
| Export permissions (create and download re-check) | `activity-reports.test.js` |
| Employee offboarding side effects | `employees.test.js`, `monitoring.test.js`, `integrations.test.js` |
| Backups restore; trigger bodies restorable | `backup.test.js` |
| Reports stay correct when aggregated in SQL | `stats-scaling.test.js` (randomized SQL-vs-JS equality) |

## 4. Test data
- **Factories** (`tests/helpers/factories.js`): `createOrg`, `createMember`, `login` (a client that keeps
  cookies and sends the CSRF header).
- **Clock control:** services take a `clock`; tests inject a fixed clock (`createFixedClock`) and advance it.
- **Seed** (`prisma/seed.js`): two organizations (Acme IT Services, Globex) to exercise isolation, each with
  an owner and six people in different roles, departments, teams, demo projects with workflows and tasks,
  and default settings. Passwords are random unless `SEED_PASSWORD` is set; the seed refuses production.
- **Volume** (`scripts/perf/generate-volume.js`): about 1.4 M rows for load tests ([performance.md](performance.md)).

## 5. CI (`.github/workflows/ci.yml`)
| Job | Steps |
|---|---|
| lint-and-unit | eslint, no-TypeScript guard, deployment checks, API/web/agent unit tests, web build |
| integration | MySQL 8.4 + Redis services; migration drift check; integration suite (OpenAPI drift and the backup round trip included) |
| e2e | MySQL; least-privilege app user provisioned; Playwright + axe |
| docker-build | builds the api, worker, migrate, ops and web images; Trivy scan (fixable critical/high fails); ops tools present |
| compose-infra | development compose stack up; the real Redis/S3 suite |

`security-scan.yml` (weekly) runs ZAP against staging and audits production dependencies.
`release.yml` reuses CI before building release images. A pull request merges only when every job passes.
