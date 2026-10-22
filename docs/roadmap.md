# Implementation Roadmap

Every phase ends with: code + migrations + tests **actually run** (with output reported),
docs updated, and an integration check against earlier phases. Every phase delivers the
per-phase report the brief requires: objective, files, DB changes, API, permissions, code,
tests, commands, verification, limitations, acceptance criteria.

Relative size: S < M < L < XL (one XL is roughly several working sessions).

| Phase | Scope | Exit / acceptance criteria | Size |
|---|---|---|---|
| **1 Architecture** ✅ (this) | Requirements, architecture, ERD, API map, RBAC matrix, routes, folder structure, monitoring, security, testing, deployment designs | Docs reviewed and approved by you. Open questions answered or defaults accepted. | M |
| **2 Foundation** ✅ ([report](phases/phase-2-foundation.md); Docker checks pending) | pnpm monorepo, shared packages, Next.js shell (JSX, Tailwind, shadcn JSX), Express app factory, env validation, pino, request ID, error envelope, health endpoints, Prisma (`prisma-client-js`) with the base tables (organizations, users, members, sessions, outbox, audit, idempotency), docker-compose (mysql, redis, minio, mailpit, nginx), Vitest + Supertest harness with an isolated test DB, CI skeleton, no-TS guard | `docker compose up` brings up all services healthy. `/api/v1/health/ready` = 200. `pnpm test` is green with real MySQL. CI is green. Zero `.ts` files. | L |
| **3 Identity & org** ✅ ([report](phases/phase-3-identity.md); Redis paths pending Docker/CI) | Auth (login, org select, logout, sessions, reset, verify, invite, MFA), CSRF, rate limits, RBAC engine (catalog, roles, scopes, overrides, cache), organizations & settings, departments, teams, employee directory & profile API with field groups, change history, offboarding hooks, audit writer, seed | All FR-AUTH/ORG/RBAC/EMP API tests pass, including the generated permission and cross-org suites. Lockout verified. | XL |
| **4 Dashboard & UI** ✅ ([report](phases/phase-4-ui.md)) | AppShell, sidebar, topbar, login screens, DataTable kit, employee directory UI, profile header + tabs (Profile, Dashboard tabs live, others stubbed with "available in phase N", never with fake data), notifications (in-app + socket + email), My Dashboard v1 | Playwright: login → directory → profile edit across 3 roles. Accessibility check (axe) has no serious violations. | L |
| **5 Attendance & time** ✅ ([report](phases/phase-5-attendance-time.md)) | member_work_states, clock and break, schedules, holidays, work-date/DST logic, missed clock-out job, corrections workflow, timer state machine, time entries + revisions, timesheets + approvals + exports, dashboard presence/hours widgets | Concurrency tests (20 parallel clock-ins → 1 success). DST and overnight unit tests. Timesheet double-count constraint test. E2E timer survives a reload. | XL |
| **6 Projects & tasks** ✅ ([report](phases/phase-6-projects-tasks.md)) | Projects, members, milestones, workflows, tasks (assignees, subtasks, checklist, labels, comments, attachments, dependencies, recurrence), kanban/list/calendar/timeline UIs, unified calendar, budget vs actual (hours), overdue job | Assignment-outside-project rejected. Dependency cycle rejected. E2E kanban drag updates status with permission. | XL |
| **7 Screenshot monitoring** ✅ ([report](phases/phase-7-screenshot-monitoring.md); desktop run and real S3 pending) | Policies + versions + precedence, consent, agent pairing/tokens/heartbeat/revoke, presign/complete/process pipeline, gallery + viewer + access logs, retention + legal hold jobs, employee monitoring page, Electron agent (capture, queue, uploader, tray, notice UI) | Idempotent duplicate upload test. Unauthorized access test. Retention job test with MinIO. Agent captures and uploads end to end on macOS in dev, with OS permission prompt shown. | XL |
| **8 Activity & reports** ✅ ([report](phases/phase-8-activity-reports.md); Redis worker run pending) | activity_events writer everywhere, daily_member_stats rollups, timelines, insights, report catalog (sync), report jobs (CSV/PDF, replica), export permissions | KPI formulas unit-tested against fixtures. Large export completes as a job. Download re-checks permission. | L |
| **9 CRM & finance** ✅ ([report](phases/phase-9-crm-finance.md); Redis worker run pending) | Clients, contacts, notes, leads + conversion, pipeline + forecast, tickets + SLA + portal, quotes, agreements, billing rates, expenses, invoices from time, payments, profitability | Decimal maths tests. Invoice can't be PAID without payments. No double-billing of time entries. Client user sees only their own client data. | XL |
| **10 HR & integrations** ✅ ([report](phases/phase-10-hr-integrations.md); Redis worker run pending) | Leave types/policies/ledger/accrual job/requests/approval chains/calendar, HR docs, onboarding/offboarding checklists, custom fields, webhooks (sign, retry, replay, logs), API keys, audit-log UI, settings pages completion | Leave balance and overlap tests. Webhook signature + replay protection tests. | L |
| **11 Hardening** ✅ ([report](phases/phase-11-hardening.md); Docker/Kubernetes runs pending a real environment) | Load tests, EXPLAIN review, partitioning migration for event tables, security review + ZAP, prod compose/k8s manifests, Nginx TLS, backups + restore-verify job, DR rehearsal, agent signing pipeline, release checklist, all remaining docs (troubleshooting, integration examples) | All acceptance criteria in the brief §33 demonstrated with evidence (test reports, restore log, load-test results). | XL |

## Dependencies & sequencing notes

- Audit, outbox, idempotency, and the RBAC engine come early (2–3) because every later module depends on them.
- Timesheets (5) need projects for full value, so phase 5 ships project/task as nullable references. Phase 6 adds the UI to pick them. Minimal `projects` rows are created via seed for testing.
- The dashboard is extended in every phase with that phase's real metrics. A widget never ships before its data exists.

## External services & credentials you will need

| Need | When | Dev substitute |
|---|---|---|
| SMTP provider (SES, Postmark, SendGrid, …) | Phase 3 for real email | Mailpit (in compose) |
| S3-compatible storage (AWS S3, R2, Wasabi, …) | Phase 7 prod | MinIO (in compose) |
| Domain + TLS | Phase 11 | localhost |
| Apple Developer account + Windows code-signing cert | Phase 7 distribution | Unsigned local builds |
| Sentry/GlitchTip DSN | Optional, any phase | Disabled |
| Managed MySQL/Redis or servers | Phase 11 | Compose |

## Open questions (defaults are assumed if unanswered)

1. Product name/brand: keep "Orbit" as a placeholder?
2. Single-org-per-user simplification acceptable, or is multi-org membership (current design, A1) required?
3. Target jurisdictions for monitoring (affects notice templates and default retention)?
4. Desktop agent OS priority: macOS + Windows (default), or Linux too?
5. Should employees see *who* viewed their screenshots (default: yes)?
6. Invoice rounding: banker's (default) or half-up?
