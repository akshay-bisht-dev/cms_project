# REST API Design

Base path: `/api/v1`. JSON only, except file downloads, which are 302 redirects to signed
URLs. The OpenAPI 3.1 document is **generated from the route declarations and Zod schemas**
(see architecture D15). It is served at `/api/docs` (Swagger UI) and `/api/openapi.json` in
non-production. This page defines the conventions and the module map. Per-endpoint details
live in the generated spec.

## 1. Conventions

### Envelope

```json
{ "success": true, "data": {}, "meta": { "page": { "nextCursor": "…", "limit": 25 } } }
```
```json
{ "success": false,
  "error": { "code": "VALIDATION_ERROR", "message": "The request is invalid",
             "details": [{ "path": "body.email", "message": "Invalid email" }] },
  "requestId": "01J…" }
```

### Status codes & error codes

| HTTP | `error.code` | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Zod failure (body, query, params) |
| 401 | `UNAUTHENTICATED`, `SESSION_EXPIRED`, `MFA_REQUIRED` | No session, expired or revoked session, MFA step pending |
| 403 | `FORBIDDEN`, `CSRF_INVALID`, `ORG_SUSPENDED` | Permission or scope missing |
| 404 | `NOT_FOUND` | Resource absent **or in another org**. The API never reveals whether a record exists in another org. |
| 409 | `CONFLICT`, `INVALID_STATE_TRANSITION`, `VERSION_CONFLICT`, `OVERLAP`, `PERIOD_LOCKED`, `IDEMPOTENCY_MISMATCH` | Business rule conflicts |
| 413 | `PAYLOAD_TOO_LARGE` | Body > limit |
| 422 | `BUSINESS_RULE_VIOLATION` | Semantically invalid (e.g. leave exceeds balance) |
| 429 | `RATE_LIMITED` | Includes a `Retry-After` header |
| 500 | `INTERNAL_ERROR` | Generic message only. Details go to logs and Sentry. |
| 503 | `UNAVAILABLE` | Readiness failing, maintenance |

### Pagination, filtering, sorting

- **Offset** (`page`, `limit` ≤ 100, `meta.page.total`) for bounded admin lists: roles, departments, leave types.
- **Cursor** (`cursor`, `limit` ≤ 100, `meta.page.nextCursor`) for everything that grows: employees, time entries, screenshots, activity, audit, notifications, tickets, tasks. The cursor is an opaque, signed base64url string of `(sortValue, id)`.
- Filters are flat query params validated per endpoint: `?status=ACTIVE&departmentId=…&from=2026-10-01&to=2026-10-31&q=alice`. Dates are ISO 8601. `from`/`to` are interpreted in the org time zone unless `tz` is given.
- Sort: `?sort=-createdAt,name`. Only fields on the endpoint's allow-list are accepted, otherwise 400.

### Headers

| Header | Use |
|---|---|
| `Cookie: orbit_sid` | Web session (HttpOnly, Secure, SameSite=Lax, Path=/) |
| `X-CSRF-Token` | Required on unsafe methods with cookie auth. Value from the `orbit_csrf` cookie (double-submit, HMAC-bound to the session). |
| `Authorization: Bearer <token>` | Desktop agent access tokens and API keys (`orb_<prefix>_<secret>`). CSRF is not applied. API keys work only on routes marked **K** in the OpenAPI document (`x-api-key: true`). |
| `Idempotency-Key` | Required on endpoints marked **I** below. 24 h replay window. Same key + different body → 409 `IDEMPOTENCY_MISMATCH`. |
| `If-Match: <version>` | Optional optimistic concurrency on PATCH for versioned resources. A mismatch → 409 `VERSION_CONFLICT`. |
| `X-Request-Id` | Echoed back. Generated if absent. |

### Rate-limit classes (Redis sliding window)

| Class | Limit | Applied to |
|---|---|---|
| `auth-strict` | 5/min per IP+email, 20/min per IP | login, forgot/reset, MFA verify |
| `write` | 120/min per member | mutations |
| `read` | 600/min per member | queries |
| `agent` | 120/min per agent | monitoring agent (heartbeat, uploads) |
| `agent-auth` | 30/min per IP | agent register / challenge / token |
| `export` | 10/hour per member | report jobs |
| `api-key` | 1000/hour per key | requests authenticated with an API key |

### Audit

Endpoints marked **A** write an `audit_logs` row in the same transaction: actor, action
(`<module>.<verb>`), target, a redacted diff, IP, and request ID. All permission, role,
security-setting, monitoring, export, finance, and HR-sensitive changes are audited, as are
screenshot views and downloads (which go to `screenshot_access_logs`).

> **As implemented (Phase 3):** the generated spec at `/api/openapi.json` (and the committed
> `apps/api/openapi/openapi.json`) is authoritative. Differences from the planning table below:
> `POST /auth/select-organization` returns `{ organizationId }` (clients refetch `/auth/me`); public
> `GET /auth/invitation`, `POST /auth/accept-invitation` and `POST /auth/resend-verification` were added;
> settings are replaced per section with `PUT /organizations/current/settings/:section`; employee export is
> a synchronous `GET /employees/export` (≤ 5,000 rows) until report jobs land in Phase 8; deny overrides
> are set with `PUT /employees/:employeeId/permission-overrides`.

## 2. Module map

Legend: **Perm** = required permission (scope resolved against the target). **I** = idempotency key required. **A** = audited. `self` = the caller's own data.

### Auth (`/auth`) — public unless noted
| Method & path | Purpose | Perm | Flags |
|---|---|---|---|
| POST /auth/login | Email + password. Returns the org list if more than one membership. | public, `auth-strict` | A |
| POST /auth/select-organization | Choose the active org (also used to switch) | session | A |
| POST /auth/mfa/verify | Complete the TOTP challenge | partial session | A |
| POST /auth/logout | Revoke the current session | session | A |
| POST /auth/refresh | **Agent only:** rotate the access token via device signature | agent | A |
| POST /auth/forgot-password · /auth/reset-password | Reset flow. Always 202 for forgot. | public | A |
| POST /auth/verify-email · /auth/accept-invitation | Token flows | public | A |
| GET /auth/me | User, active membership, effective permissions, feature flags | session | |
| POST /auth/change-password | Revokes other sessions | session | A |
| GET /auth/sessions · DELETE /auth/sessions/:sessionId | Device and session history, revoke | session (self) | A |
| POST /auth/mfa/setup · /auth/mfa/enable · /auth/mfa/disable | TOTP enrollment | session | A |

### Organization, roles, structure
| Method & path | Perm | Flags |
|---|---|---|
| POST /organizations (register) | public + email verification | A |
| GET/PATCH /organizations/current | `org.settings.read` / `org.settings.manage` | A |
| GET/PATCH /organizations/current/settings/:section | same | A |
| GET /permissions · GET/POST /roles · PATCH/DELETE /roles/:roleId | `roles.manage` (GET permissions: any member) | A |
| GET/POST /departments · PATCH/DELETE /departments/:id | `departments.manage` (GET: `employees.read`) | A |
| GET/POST /teams · PATCH/DELETE /teams/:id · PUT /teams/:id/members | `teams.manage` | A |
| GET/POST /work-schedules · PATCH /work-schedules/:id · POST /schedule-assignments | `org.settings.manage` | A |
| GET/POST /holiday-calendars · /holiday-calendars/:id/holidays | `org.settings.manage` | A |
| GET/POST /custom-fields · PATCH/DELETE /custom-fields/:id | `customfields.manage` | A |

### Employees (`/employees`)
| Method & path | Perm | Flags |
|---|---|---|
| GET /employees | `employees.read` (scoped) | |
| POST /employees (direct create, invite pending) | `employees.create` | I, A |
| GET /employees/:employeeId | `employees.read`. Field groups filtered by `employees.fields.<group>.read`. | |
| PATCH /employees/:employeeId | `employees.update` + per-group write permission; employees can edit their own `basic`/`contact` | A |
| DELETE /employees/:employeeId (archive) | `employees.archive` | A |
| POST /employees/invitations · POST /invitations/:id/resend · DELETE /invitations/:id | `invitations.manage` | I, A |
| POST /employees/:id/activate · /deactivate · /offboard | `employees.deactivate` | I, A |
| GET /employees/:id/{activity, attendance, timesheets, screenshots, projects, tasks, leave, documents, history} | the respective module's read permission, scoped | screenshots: access-logged |
| POST /employees/export | `employees.export` → report job | A |

### Attendance & time
| Method & path | Perm | Flags |
|---|---|---|
| GET /attendance/state | `attendance.self` (state + open session + timer) | |
| POST /attendance/clock-in · /clock-out · /break/start · /break/end | `attendance.self` | I |
| GET /attendance/me · GET /attendance (filters: member, dept, team, date range, status) | `attendance.self` / `attendance.read` | |
| POST /attendance/corrections · GET /attendance/corrections | `attendance.correct.request` / `attendance.read` | A |
| POST /attendance/corrections/:id/approve · /reject | `attendance.correct.approve` (scoped, not own) | A |
| POST /time-tracking/start · /pause · /resume · /stop · /switch | `time.self` | I |
| GET /time-tracking/active | `time.self` | |
| GET /time-entries · POST /time-entries (manual) | `time.read` / `time.manual` | POST: I, A |
| PATCH /time-entries/:id · DELETE /time-entries/:id | own unlocked: `time.manual`. Others': `time.edit.others`. | A (revision row) |

### Timesheets
| Method & path | Perm | Flags |
|---|---|---|
| GET /timesheets · POST /timesheets (create/refresh draft for period) | `timesheets.submit` (own) / `timesheets.read` | |
| GET/PATCH /timesheets/:id | owner while DRAFT/REJECTED | A |
| POST /timesheets/:id/submit | owner | I, A |
| POST /timesheets/:id/approve · /reject (comment required) · /reopen | `timesheets.approve` (scoped, not own) · reopen: `timesheets.unlock` | I, A |
| GET /timesheets/:id/history · GET /timesheets/:id/export?format=csv\|pdf | read | |

### Monitoring
Implemented in Phase 7 (generated OpenAPI is authoritative). Agent routes use a bearer token (`AGENT` access level); browser sessions are refused there, and agent tokens are refused everywhere else.

| Method & path | Perm | Flags |
|---|---|---|
| GET /monitoring/me (policy, notice, consent + history, devices, who can view, 7-day counts) | `monitoring.self` | |
| POST /monitoring/me/consent `{action: ACKNOWLEDGED\|WITHDRAWN, policyVersionId}` | `monitoring.self` | A |
| POST /monitoring/me/pairing-codes (8 chars, 5 min, newest only) | `monitoring.self` | |
| GET /monitoring/policies · GET /policies/:id/versions | `monitoring.policy.read` (org scope) | |
| GET /monitoring/policies/effective?employeeId= | `monitoring.policy.read` (scoped) | |
| POST /monitoring/policies · PATCH /policies/:id · POST /policies/:id/versions · PUT /policies/:id/assignments | `monitoring.policy.manage` | A |
| GET /monitoring/agents?employeeId= · POST /monitoring/agents/:agentId/revoke | `monitoring.agents.manage` (scoped; self by default) | A |
| POST /monitoring/agent/register · /agent/challenge · /agent/token | public, `agent-auth` rate limit | A (register) |
| POST /monitoring/agent/heartbeat (returns the capture permit) | agent | |
| POST /monitoring/agent/uploads/presign · /complete · /fail | agent | idempotent per `clientCaptureId` |
| GET /monitoring/screenshots (cursor; employeeId, projectId, from/to ≤ 31 days, status) · GET /monitoring/timeline?employeeId&date | `monitoring.screenshots.read` (scoped) | |
| GET /monitoring/screenshots/:id · GET /:id/access-log (subject or deleters) | same | |
| POST /monitoring/screenshots/access-urls `{ids ≤ 60, variant: thumb\|full\|download}` | read; download also needs `monitoring.screenshots.download` | access-logged, 60 s URLs |
| DELETE /monitoring/screenshots/:id · GET /monitoring/deletions | `monitoring.screenshots.delete` (409 `LEGAL_HOLD`) | A |
| GET/POST /monitoring/legal-holds · POST /legal-holds/:id/release | `monitoring.legalhold.manage` | A |

### Projects & tasks
| Method & path | Perm | Flags |
|---|---|---|
| GET /projects · POST /projects | `projects.read` (visibility + membership) / `projects.create` | A |
| GET/PATCH/DELETE(archive) /projects/:id · POST /projects/:id/restore · /close | `projects.manage` (scope: project role MANAGER or org) | A |
| POST /projects/:id/members · DELETE /projects/:id/members/:userId · PUT bulk | `projects.manage` | A |
| GET /projects/:id/{tasks, milestones, workload, budget, activity, documents} | `projects.read` (+ `projects.budget.read` for budget) | |
| GET/POST/PATCH /projects/:id/statuses · /milestones | `projects.manage` | |
| GET /tasks (cross-project: assignee, status, due, label, q) · POST /tasks | `tasks.read` / `tasks.create` (project member) | |
| GET/PATCH/DELETE /tasks/:id · POST /tasks/bulk | `tasks.update` (assignee or project manager) | A on status/assignee |
| POST /tasks/:id/comments · /attachments (presign + complete) · /dependencies · /checklist | `tasks.read` + member | |
| GET /calendar?from&to&sources= | union of sources the caller can read | |

### CRM, sales & support (Phase 9)
| Method & path | Perm |
|---|---|
| GET/POST /clients · GET/PATCH /clients/:id · POST /:id/archive · /:id/restore | `clients.read` (org, or clients of projects I manage) / `clients.manage` |
| POST/PATCH/DELETE /clients/:id/contacts · GET/POST /clients/:id/notes · GET/POST/PATCH /clients/:id/agreements | `clients.manage` (notes: `clients.read`) |
| GET/POST /clients/:id/portal-users · POST /:id/portal-users/:memberId/revoke | `clients.manage` (A, I) |
| GET/POST /leads · PATCH /leads/:id · POST /leads/:id/convert (client + contact + opportunity, once) | `leads.manage` (I, A) |
| GET/POST/PATCH /pipeline-stages · GET/POST/PATCH /opportunities · GET /pipeline (value measured, forecast estimated, base currency) | `opportunities.manage` |
| GET/POST /sales-activities · POST /sales-activities/:id/done | `leads.manage` or `opportunities.manage` |
| GET/POST /quotes · GET/PATCH /quotes/:id · POST /:id/send · /accept · /decline · /revise | `quotes.manage` |
| GET/POST /support-tickets · GET/PATCH /support-tickets/:id · POST /:id/comments (INTERNAL needs read, PUBLIC needs manage) | `tickets.read` / `tickets.manage` (self = assigned/reported, team = teams I lead, project = projects I manage, org) |
| GET/POST/PATCH /sla-policies (targets per priority, optional business-hours schedule) | `tickets.read` / `tickets.manage` (org) |
| GET /portal · /portal/projects · GET/POST /portal/tickets · GET /portal/tickets/:id · POST /portal/tickets/:id/comments · GET /portal/invoices · /portal/invoices/:id · /pdf | `tickets.client` + `allowClient`: client users only, always filtered by their own client |

**Client users** (member type CLIENT) are refused on every route not declared `allowClient` (only the portal, notifications and own-account routes), whatever their roles, so a mis-granted permission cannot expose internal data. The generated route test enforces this for every route.

### Leave, HR & custom fields (Phase 10)
Balances are sums of an append-only ledger (accruals, usage, cancellations, carry-over, adjustments). Days are counted at half-day precision over the member's working days: their schedule, or Monday–Friday when no schedule exists, minus holidays.

| Method & path | Perm |
|---|---|
| GET /leave/types | member · POST /leave/types · PATCH /leave/types/:id — `leave.policy.manage` |
| GET/POST /leave/policies · PATCH /leave/policies/:id · PUT /leave/policies/:id/assignments `{targets:[{type: DEPARTMENT\|TEAM\|MEMBER, id}]}` (member > team > department > default) | `leave.policy.manage` |
| GET /leave/balances · GET /leave/ledger (`?employeeId=` needs `leave.read` covering them) | `leave.self` |
| POST /leave/balances/adjust (ledger entry; I, A) | `leave.balance.adjust` |
| POST /leave/requests/preview → `{days, available, afterRequest, allowNegative}` | `leave.self` |
| POST /leave/requests (I; overlap at half-day precision under a row lock → 409; balance → 422 unless the policy allows negative) · GET /leave/requests?view=mine\|approvals\|team | `leave.self` |
| GET /leave/requests/:id · POST /leave/requests/:id/cancel (owner before it starts; HR any time; I, A) | member (access checked) |
| POST /leave/requests/:id/approve · /reject (comment required) — only an approver of the current chain step (MANAGER, TEAM_LEAD, HR); never the requester (I, A) | `leave.approve` |
| GET /leave/calendar?from&to | `leave.read` (scoped) |
| GET /employees/:id/documents · GET /employees/:id/documents/:docId/download (60 s link; audited) | `documents.hr.read` (HR: all; employee: own, shared only) |
| POST /employees/:id/documents/uploads (presign) · POST /employees/:id/documents · DELETE /employees/:id/documents/:docId · GET /hr/documents/expiring?days= | `documents.hr.manage` |
| GET/POST /checklist-templates · PATCH /checklist-templates/:id · POST /employees/:id/checklists | `employees.create` |
| GET /employees/:id/checklists · GET /checklist-tasks (mine) · POST /checklist-tasks/:id/done | member (the employee, their manager, assignees, HR) |
| GET /custom-fields (K) | member · POST /custom-fields · PATCH /custom-fields/:id — `customfields.manage` |
| GET /custom-fields/values/:entity/:entityId (K; `meta.canEdit`) · PUT (by key) | read / edit access to that record (EMPLOYEE, PROJECT, TASK, CLIENT, TICKET) |

### Finance (Phase 9)
Money is sent and returned as decimal strings (never floats). Lines round half-to-even at the currency's minor unit; totals are sums of rounded lines.

| Method & path | Perm |
|---|---|
| GET/POST /billing-rates · POST /billing-rates/:id/end | `finance.rates.manage` (cost rates also need `finance.cost.read`); periods may not overlap (409 `OVERLAP`) |
| GET/POST /exchange-rates | `finance.rates.manage` |
| GET /expense-categories · POST/PATCH /expense-categories | `finance.expenses.submit` / `finance.rates.manage` |
| GET /expenses?view=mine\|approvals\|all · POST /expenses · PATCH/DELETE /expenses/:id · POST /:id/submit · /:id/decide · /:id/reimburse · GET /:id/receipt · POST /expenses/receipts (+ /:fileId/confirm) | submit / `finance.expenses.approve` (project or org; never own) / `finance.payments.record` |
| GET/POST /invoices · GET/PATCH/DELETE /invoices/:id · GET /:id/pdf | `finance.invoices.read` / `finance.invoices.manage` |
| GET /invoices/billable-time · POST /invoices/:id/time · GET /:id/billable-expenses · POST /:id/expenses · POST/DELETE /:id/items | `finance.invoices.manage`; approved billable time only; UNIQUE(time_entry) → `ALREADY_BILLED` |
| POST /invoices/:id/issue (number INV-NNNNN, due date from client terms) · POST /:id/void (no net payments; frees time and expenses) | `finance.invoices.manage` (I, A) |
| POST /invoices/:id/payments (negative = refund; can't exceed outstanding) | `finance.payments.record` (I, A); status follows the ledger; DB CHECK: PAID ⇒ amount_paid ≥ total > 0 |

### Reports, activity & insights
Implemented in Phase 8. Every report column declares `kind` (measured / derived / estimated) and `type` (duration in seconds, percent as 0–1, count, text).

| Method & path | Perm |
|---|---|
| GET /reports (catalog filtered by permission) | member |
| GET /reports/attendance · /time (groupBy member\|project\|day) · /projects · /monitoring — `from, to` (≤ 31 days), `groupBy`, `employeeId`, `teamId`, `departmentId` | `reports.attendance.read` (attendance, time) · `reports.projects.read` · `reports.monitoring.read`; data scoped to the caller |
| POST /reports/jobs `{type, format: csv\|pdf, params}` (≤ 366 days; I, A; rate `export`) · GET /reports/jobs · GET /reports/jobs/:id · GET /reports/jobs/:id/download (60 s link; permission re-checked; A) | `reports.export` + the report's permission |
| GET /activity/day · /activity/week · /activity/team · /activity/trends | `reports.attendance.read` (scoped); monitoring figures only where `reports.monitoring.read` covers the person |
| POST /monitoring/agent/idle `{intervals: [{id, startedAt, endedAt}]}` | agent; only when the policy enables idle detection |
| GET /dashboard/summary | `dashboard.read`, scoped (trends live under /activity/trends) |

Not yet built (their phases add them): leave, CRM, tickets and finance reports.

### Notifications, audit, integrations, platform
| Method & path | Perm |
|---|---|
| GET /notifications · POST /notifications/:id/read · POST /notifications/read-all · GET/PUT /notifications/preferences | self |
| GET /audit-logs (cursor in `meta.page.nextCursor`; `action` prefix, `actorId` (employee id), `targetType`, `targetId`, `from`/`to`) | `audit.read` |
| /integrations (packaged third-party connectors) | not built; `integrations.manage` is reserved for it |
| GET /webhooks/events · GET/POST /webhooks (secret shown once) · PATCH/DELETE /webhooks/:id · POST /webhooks/:id/rotate-secret · POST /webhooks/:id/ping · GET /webhooks/:id/deliveries · POST /webhooks/:id/deliveries/:deliveryId/replay | `webhooks.manage` (A). HTTPS only; private, loopback and link-local addresses refused at connect time. Signature: see [integrations.md](integrations.md). |
| GET /api-keys (`?mine=true`) · POST /api-keys/:id/revoke | member (own keys; all with `apikeys.manage`) (A) |
| POST /api-keys `{name, scopes, expiresInDays?}` — key shown once; scopes must be permissions you hold, and the key acts with your scopes intersected with its own | `apikeys.manage` (A) |
| GET/POST /files/presign · POST /files/complete · GET /files/:id/access-url | owner module's permission |
| POST /data/export · POST /data/erasure-requests | `org.data.manage` (A) |
| /platform/* (orgs, health, support-grants) | platform admin + grant (A) |
| GET /health/live · GET /health/ready | public (ready checks DB, Redis, storage) |

## 3. Fully specified critical endpoints (examples)

### POST /api/v1/attendance/clock-in
- **Purpose:** open a work session for the caller.
- **Auth:** session or agent token. **Perm:** `attendance.self`. **Rate:** `write`. **Idempotency-Key:** required.
- **Body (Zod):** `{ note?: string(0..280), source?: 'WEB'|'AGENT' }`. The server derives everything else: timestamp, work date, schedule.
- **Rules:** lock `member_work_states`; state must be `OFF`; membership must be ACTIVE; the org must not be suspended. Approved full-day leave today → 422 `ON_LEAVE` unless `attendance.allowOnLeave`.
- **201:** `{ data: { state: 'WORKING', workSession: { id, startedAt, workDate }, attendance: { id, status, flags } } }`
- **Errors:** 401, 403, 409 `INVALID_STATE_TRANSITION` (already working), 422 `ON_LEAVE`, 429.
- **Side effects:** activity event `attendance.clock_in`, outbox `presence.changed`. Not audited (high volume). The activity event is the record.

### POST /api/v1/monitoring/agent/uploads/presign
- **Auth:** agent bearer (HS256, `aud=agent`, 15 min; obtained by signing a one-time challenge with the device's Ed25519 key). **Rate:** `agent`.
- **Body:** `{ clientCaptureId: uuid, capturedAt: datetime, policyVersionId: uuid, sha256: hex, sizeBytes: int(1..8 MB), mimeType: 'image/webp'|'image/jpeg'|'image/png', width, height: int(1..8192) }`
- **Rules:** the member's consent record in force at `capturedAt` acknowledges exactly that version's notice hash; the version enabled capture and was published before `capturedAt`; `capturedAt` lies inside a work session and outside any break; not older than 73 h or more than 60 s in the future. Project and task come from the time entry running at `capturedAt` (not from the agent). Legal holds are applied at insert. An existing `(agentId, clientCaptureId)` returns the same record: a fresh URL while `PENDING_UPLOAD`, `upload: null` once uploaded, 409 if the checksum differs.
- **200:** `{ data: { screenshotId, status, upload: { url, method: 'PUT', headers, expiresAt } | null } }` (URL TTL 5 min, size-bound)
- **Errors:** 401 `AGENT_REVOKED`/`INVALID_TOKEN`, 422 `CONSENT_REQUIRED`, 422 `CAPTURE_NOT_PERMITTED` (details: `POLICY_DISABLED`, `OUTSIDE_WORK_SESSION`, `ON_BREAK`, `EXPIRED`), 409 `IDEMPOTENCY_MISMATCH`.
- **Then:** PUT to storage → `/complete` (HEAD verifies size and type) → worker `screenshot.process` (sha-256 recheck, sharp decode, WebP + 320 px thumbnail, metadata stripped) → `READY`.

### POST /api/v1/timesheets/:timesheetId/approve
- **Perm:** `timesheets.approve`, with a scope covering the owner (team / department / project / org). The approver cannot be the owner. **Idempotency-Key** required. **If-Match** recommended.
- **Body:** `{ comment?: string(0..2000) }`
- **Rules:** status must be `SUBMITTED`. All linked entries are unchanged since submission (hash of entry versions matches the submission snapshot), otherwise 409 `STALE_TIMESHEET`.
- **200:** the timesheet, with `status: 'APPROVED'` and the appended approval record.
- **Audit:** `timesheets.approve`. Outbox: notify owner, webhook `timesheet.approved`.
