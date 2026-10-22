# System Requirements

## 1. Purpose and scope

The platform runs the operational core of an IT services company. The company employs
engineers, bills clients for their time, and needs evidence of work. The platform combines:

- workforce tracking: attendance, timers, transparent screenshot monitoring, activity
- delivery: projects, tasks, timesheets
- people operations: directory, profiles, leave, onboarding and offboarding
- commercial: CRM, tickets, quotes, invoices, expenses, profitability
- administration: multi-tenant organizations, RBAC, audit, integrations

## 2. UI reference analysis

No screenshot was attached to the request, so this analysis works from the characteristics
the request describes. The usual layout of a Workstatus-style employee profile has five parts:

| Element | Interpretation for our design |
|---|---|
| Dark purple fixed left sidebar | 264px expanded / 72px collapsed rail, grouped nav, icon + label, active item highlighted with a lighter purple pill and left accent |
| Clean light workspace | `gray-50` page background, white cards, 24px gutters |
| Employee profile header | Avatar, name, designation, employee ID, status badge (Working / On break / Not working / On leave / Absent), quick actions (Edit, Message, Deactivate) |
| Status badges | Semantic color + text label (never color alone), e.g. green "Working", amber "On break", gray "Not working", blue "On leave", red "Absent" |
| Tab navigation | Horizontal underline tabs under the header; each tab is its own URL segment so it can be deep-linked and is permission-filtered |
| Structured info cards | Two-column grid of titled cards ("Basic information", "Employment", "Contact", "Schedule"), each with a key/value grid and an inline Edit action |

The brand is original. Working name: **Orbit**, with a neutral geometric mark. Workstatus
logos, iconography, and copy are not reused.
**Action item:** attach the screenshot before Phase 4 so spacing and density can be matched more closely.

## 3. Assumptions

These are documented defaults so work can continue. Each one is configurable unless marked otherwise.

| ID | Assumption |
|---|---|
| A1 | **Identity is global, membership is per organization.** One `users` row per email. A person can belong to several organizations (contractors, client users). Every request runs in one *active organization* chosen at login or on switch. |
| A2 | The web app is served **same-origin**: Nginx routes `/api/*` to Express and everything else to Next.js. This allows HttpOnly session cookies without cross-site CORS. |
| A3 | "Project Management" in the sidebar is the **portfolio view** (all projects, workload, budget health). "Projects" is the project list and detail. |
| A4 | Full-desktop screenshots require the **Electron desktop agent**. The browser app shows monitoring status and gallery but never captures the desktop by itself. |
| A5 | Default work day = the local calendar date (employee time zone) on which a work session **starts**. Overnight shifts belong to the start date. |
| A6 | Default timer policy: **one active timer per employee**. A timer requires an open work session (clocking in is automatic on timer start if the org enables it). |
| A7 | Default screenshot interval 10 min (org range 5–60 min). Default retention 90 days. Monitoring is **off** until an owner enables a policy and each employee acknowledges the notice. |
| A8 | Currencies use ISO 4217 codes. Each organization has a base currency. Multi-currency invoices are stored in their own currency. Cross-currency reporting uses rates entered by Finance; no external FX feed in v1. |
| A9 | Email goes through SMTP (any provider). In development it goes to Mailpit. |
| A10 | Payments: v1 records payments manually, with a reconciliation reference. An invoice becomes PAID only when payment records cover the total. A provider integration (e.g. Stripe) is a later extension. |
| A11 | Design scale target for v1: 500 orgs, 50k members in total, largest org 5k members, 10k concurrently monitored employees. |
| A12 | Legal basis for monitoring (notice vs consent, works-council approval) differs by jurisdiction. The platform supplies notice, acknowledgement, withdrawal, and retention tooling. The organization stays responsible for lawful use, and the UI says so. |

## 4. Functional requirements

Requirement IDs (`FR-<module>-<n>`) are referenced by tests and roadmap acceptance criteria.

### 4.1 Identity, auth, organizations (AUTH, ORG)
- FR-AUTH-1 Email + password login with Argon2id hashing. Generic error messages. Progressive lockout after repeated failures, per account and per IP.
- FR-AUTH-2 Invitation-based registration. Invites are single use, expire after 7 days, and can be resent or revoked.
- FR-AUTH-3 Email verification, forgot password, and reset password. Tokens are random, stored hashed, single use, and short-lived (reset: 30 min).
- FR-AUTH-4 Opaque server-side sessions in HttpOnly cookies. Users can list and revoke sessions and see device and IP history. A password change revokes all other sessions.
- FR-AUTH-5 Optional TOTP MFA with recovery codes. Organizations can enforce MFA per role.
- FR-AUTH-6 Account states: invited → active → suspended / deactivated → archived.
- FR-ORG-1 Organization registration (creates the owner membership), profile, logo, branding color, time zone, base currency, locale, week start.
- FR-ORG-2 Departments (tree, one manager), teams (lead + members, many-to-many with employees), reporting manager hierarchy, cycle-free.
- FR-ORG-3 Organization limits (seats, storage) and status (trial, active, suspended).

### 4.2 RBAC (RBAC)
- FR-RBAC-1 System roles: Owner, HR Manager, Project Manager, Team Lead, Employee, Finance Manager, Client User. Platform Super Admin is separate and not an org role.
- FR-RBAC-2 Custom roles built from the permission catalog. Each grant carries a **scope** (`self`, `team`, `department`, `project`, `org`).
- FR-RBAC-3 Per-employee restrictions (deny-overrides) and project-level roles (project manager / member / viewer).
- FR-RBAC-4 Every API operation checks permission and scope on the server. The UI hides what the user cannot do, but the UI is not the security boundary.

### 4.3 Employees (EMP)
- FR-EMP-1 Directory with search (name, email, phone, employee ID, designation), filters (department, team, role, status, manager), sort, pagination, and authorized CSV export.
- FR-EMP-2 Profile with 12 tabs (Dashboard, Attendance, Time Off, Profile, App Settings, Integrations, Activity, Projects, Tasks, Timesheets, Screenshots, Documents). Tabs are hidden when the user lacks permission.
- FR-EMP-3 Field groups with separate read and write permissions: `basic`, `work`, `contact`, `personal` (personal email, address), `emergency`, `employment` (type, probation, notice), `security` (MFA status, sessions). Profile completion % is computed server-side.
- FR-EMP-4 Field-level change history (who, when, old → new). Sensitive groups are stored redacted in history.
- FR-EMP-5 Onboarding and offboarding checklists. Offboarding revokes sessions and desktop agents, stops timers, and closes open work sessions.

### 4.4 Attendance (ATT)
- FR-ATT-1 Clock in/out, start/end break, multiple sessions per day, server timestamps only.
- FR-ATT-2 Daily, weekly, and monthly summaries. Late arrival and early departure come from the effective schedule plus grace minutes. Absence comes from a scheduled day with no session, no leave, and no holiday.
- FR-ATT-3 Missed clock-out detection: an open session past schedule end + grace (default 4h) or past the max session length (default 16h) is auto-closed at the last known activity (or schedule end), flagged `AUTO_CLOSED`, and the employee and manager are notified to correct it.
- FR-ATT-4 Correction requests (add, modify, or delete a session or break) with an approval workflow. Approved corrections create new versions. Originals are kept.
- FR-ATT-5 Work schedules: fixed, flexible (required hours per day or week), and shift-based including overnight. Holiday calendars per org, optionally per location.
- FR-ATT-6 Invalid transitions are rejected with `409 INVALID_STATE_TRANSITION` (e.g. clock-in while clocked in, break while not working).

### 4.5 Time tracking (TIME)
- FR-TIME-1 Timer start / pause / resume / stop / switch project or task. Description and billable flag. State comes from the server, so it survives refresh and reconnect.
- FR-TIME-2 Time entries are linked to member, organization, work session, project, and task. Manual entries and edits require permission and keep a revision history.
- FR-TIME-3 Entries for one member cannot overlap (validated in a transaction under a per-member lock).
- FR-TIME-4 Entries inside an approved timesheet period are locked. Changing them requires an authorized unlock, which is audited.

### 4.6 Timesheets (TS)
- FR-TS-1 Reporting periods (weekly default; daily, bi-weekly, semi-monthly configurable).
- FR-TS-2 Draft → Submitted → Approved / Rejected → (Resubmitted). Eligible entries are aggregated automatically. Each entry belongs to at most one non-rejected timesheet, enforced by a unique constraint.
- FR-TS-3 Reviewer comments. An immutable approval history.
- FR-TS-4 CSV and PDF exports.

### 4.7 Screenshot monitoring (MON) — see [screenshot-monitoring.md](screenshot-monitoring.md)
- FR-MON-1 Policies at org, team, and employee level with a defined precedence. Interval, schedule, blur, exclusions, retention.
- FR-MON-2 Versioned policies. Every capture records the policy version in effect.
- FR-MON-3 Notice and acknowledgement records. Employees can withdraw, which stops capture.
- FR-MON-4 Desktop agent registration, heartbeat, revocation, visible indicator, pause on stop or break.
- FR-MON-5 Presigned direct upload to private storage, idempotent retries, server-side validation (MIME, size, dimensions, checksum).
- FR-MON-6 Gallery with filters, short-lived signed URLs, access and deletion logs, retention, legal holds.

### 4.8 Activity & insights (ACT)
- FR-ACT-1 Append-only activity events for the listed event types.
- FR-ACT-2 Daily and weekly timelines, project distribution, team overview, screenshot coverage, capture failures, billable vs non-billable, task completion.
- FR-ACT-3 Every metric is labelled **measured**, **derived**, or **estimated**. The UI never presents screenshot counts or input activity as "productivity".
- FR-ACT-4 Idle detection (agent only, off by default) records *idle intervals*, never input contents.

### 4.9 Projects & tasks (PRJ, TSK)
- FR-PRJ-1 Project CRUD, archive, close, restore. Fields as specified, plus templates.
- FR-PRJ-2 Views: list, kanban (by status), calendar, timeline (Gantt-lite using milestones and task dates), detail dashboard, workload, budget vs actual.
- FR-PRJ-3 Visibility: `private` (members only), `org` (all members can view).
- FR-TSK-1 Tasks with multiple assignees, subtasks (one level of parent/child), checklists, labels, custom fields, comments, attachments, dependencies (finish-to-start, cycle-free), recurrence (RRULE), configurable workflow statuses per project.
- FR-TSK-2 Assignees must be project members. Status changes follow the workflow's allowed transitions.

### 4.10 Leave & HR (LV, HR)
- FR-LV-1 Leave types, policies (accrual rule, carry-over cap, negative-balance allowance), balances held as a **ledger** (accrual, usage, adjustment, expiry entries) so the balance can be rebuilt from history.
- FR-LV-2 Full and half-day requests. Overlap validation. Working-day calculation that respects schedule and holidays.
- FR-LV-3 Configurable approval chain (e.g. Team Lead → HR). Cancellation (before start, or partially for future days).
- FR-HR-1 Employment documents (private storage), probation and notice fields, onboarding and offboarding.

### 4.11 CRM & service delivery (CRM, TKT)
- FR-CRM-1 Clients, contacts, notes, documents, communication history, status.
- FR-CRM-2 Leads (source, owner, qualification, follow-up, score, lost reason) and conversion to client + contact + opportunity in one transaction.
- FR-CRM-3 Opportunities with pipeline stages, probability, value + currency, weighted forecast.
- FR-TKT-1 Support tickets with priority, status, team, SLA policy (first response and resolution deadlines), internal vs client-visible comments, attachments, time logged, history.
- FR-CRM-4 Proposals and quotes (versioned), service agreements.

### 4.12 Finance (FIN)
- FR-FIN-1 Billing rates by precedence: project-member > project > client > employee > org default, each with effective dates.
- FR-FIN-2 Expenses, categories, approval.
- FR-FIN-3 Invoices with line items (from approved billable time, expenses, or manual lines), tax lines, due dates. Status is derived from payment records.
- FR-FIN-4 Revenue, cost, and margin reports. Cost uses member cost rates, which only Finance can see.

### 4.13 Calendar & notifications (CAL, NTF)
- FR-CAL-1 Unified calendar as a read model over leave, holidays, milestones, task deadlines, meetings, follow-ups, SLA deadlines, and attendance. Each source is filtered by the viewer's permissions.
- FR-NTF-1 In-app, email, and real-time channels. Per-user preferences per event type. Deduplication key per (recipient, event, subject). Retries.

### 4.14 Reports (RPT)
- FR-RPT-1 The report catalog in [api-reference.md](api-reference.md#reports). Each KPI has a written formula (see the KPI table below).
- FR-RPT-2 Synchronous for small ranges (≤ 31 days and ≤ 10k result rows). Larger ones run as background jobs with status and a signed download link.
- FR-RPT-3 Exports re-check permission when the job is created **and** when it is downloaded.

### 4.15 Settings, integrations, platform (SET, INT, PLT)
- FR-SET-1 All settings pages listed in the brief.
- FR-INT-1 Outbound webhooks: HMAC-SHA256 signatures, timestamp + nonce for replay protection, exponential retries, delivery logs, manual replay.
- FR-INT-2 API keys: prefixed, hashed, scoped, expiring, rate limited.
- FR-PLT-1 Super Admin can manage orgs and platform health. Tenant data access requires a **support access grant** approved by the org owner. Grants are time-boxed and every access is audited.

## 5. KPI definitions

| KPI | Formula | Kind |
|---|---|---|
| Tracked time | Σ `time_entries.duration_s` for entries whose interval falls in range (entries are clipped at range boundaries) | measured |
| Billable hours | Σ duration of entries with `is_billable = true` | measured |
| Billable utilization | billable time ÷ scheduled working time (schedule − holidays − approved leave) | derived |
| Attendance rate | days present ÷ scheduled working days | derived |
| Late arrival | first session start > schedule start + grace | derived |
| Overtime | max(0, worked time − scheduled time) per day (or per week, by policy) | derived |
| Break duration | Σ `break_sessions` duration | measured |
| Screenshot coverage | successful captures ÷ expected captures, where expected = ⌊monitored active time ÷ interval⌋ | derived |
| Upload failure rate | failed ÷ (successful + failed) captures | measured |
| Budget utilization | (Σ approved billable time × applicable rate + approved expenses) ÷ project budget | derived |
| Hours utilization | actual hours ÷ estimated hours | derived |
| Project margin | (invoiced or billable revenue − cost) ÷ revenue, where cost = Σ time × member cost rate + expenses | derived |
| Pipeline value | Σ open opportunity value (in base currency) | measured |
| Weighted forecast | Σ value × probability for opportunities expected to close in the period | estimated |
| Lead conversion | leads converted ÷ leads created in cohort | derived |
| Ticket SLA attainment | tickets resolved before `resolution_due_at` ÷ tickets resolved | derived |
| Overdue invoices | invoices with `due_date < today` and outstanding > 0 | measured |

## 6. Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-1 Performance | p95 < 300 ms for list and detail APIs at design scale. Dashboard aggregates < 800 ms (cached ≤ 60 s). Clock and timer actions < 200 ms. |
| NFR-2 Availability | 99.9% monthly target for the API. Stateless API and web tiers allow rolling deploys with zero downtime. |
| NFR-3 Scalability | Horizontal API, web, and worker replicas. Shared Redis for sessions cache, rate limits, queues, and the Socket.IO adapter. |
| NFR-4 Durability | RPO ≤ 15 min (binlog shipping). RTO ≤ 4 h. Restores verified weekly. |
| NFR-5 Security | OWASP ASVS L2 as the baseline. See [security-privacy.md](security-privacy.md). |
| NFR-6 Privacy | Data minimization, documented purposes, retention enforced by jobs, subject-access export. |
| NFR-7 Accessibility | WCAG 2.2 AA: keyboard navigable, visible focus, 4.5:1 text contrast, status never shown by color alone. |
| NFR-8 Observability | JSON logs with request ID, Prometheus metrics, error monitoring, queue dashboards. |
| NFR-9 i18n | UTC storage. All rendering uses IANA time zones. Locale-aware number, currency, and date formatting. English strings externalized. |
| NFR-10 Browser support | Last 2 versions of Chrome, Edge, Firefox, and Safari. Responsive from 360px. |

## Module matrix

✓ = in scope. RT = real-time push. Phase = roadmap phase that delivers it.

| Module | Web UI | REST API | DB tables | Jobs | RT | Audit | Phase |
|---|---|---|---|---|---|---|---|
| Auth & sessions | ✓ | ✓ | users, user_sessions, mfa_settings, auth_tokens | email | — | ✓ | 3 |
| Organizations / settings | ✓ | ✓ | organizations, organization_settings | — | — | ✓ | 3 |
| Roles & permissions | ✓ | ✓ | roles, permissions, role_permissions, member_roles | cache bust | — | ✓ | 3 |
| Departments / teams | ✓ | ✓ | departments, teams, team_members | — | — | ✓ | 3 |
| Employees & profiles | ✓ | ✓ | organization_members, employee_profiles, profile_change_history, invitations | invite email | ✓ status | ✓ | 3–4 |
| Dashboard | ✓ | ✓ | read models over all | cache warm | ✓ | — | 4, extended each phase |
| Notifications | ✓ | ✓ | notifications, notification_preferences | delivery, email | ✓ | — | 4 |
| Attendance | ✓ | ✓ | attendance_records, work_sessions, break_sessions, attendance_corrections, work_schedules, holidays | missed clock-out, anomalies | ✓ | ✓ | 5 |
| Time tracking | ✓ | ✓ | member_work_states, time_entries, time_entry_revisions | — | ✓ | ✓ | 5 |
| Timesheets | ✓ | ✓ | timesheets, timesheet_entries, timesheet_approvals | reminders | ✓ | ✓ | 5 |
| Projects | ✓ | ✓ | projects, project_members, milestones, project_documents | budget threshold | ✓ | ✓ | 6 |
| Tasks | ✓ | ✓ | tasks, task_* | overdue, recurrence | ✓ | ✓ | 6 |
| Calendar | ✓ | ✓ | calendar_events + read model | — | — | — | 6 |
| Screenshot monitoring | ✓ | ✓ | capture_policies, …, screenshots, *_logs | processing, retention | ✓ | ✓ | 7 |
| Desktop agent | Electron | ✓ | desktop_agents, agent_heartbeats | — | — | ✓ | 7 |
| Activity & insights | ✓ | ✓ | activity_events, daily_member_stats | rollups | — | — | 8 |
| Reports & exports | ✓ | ✓ | report_jobs, file_metadata | generation | ✓ status | ✓ | 8 |
| Clients / contacts | ✓ | ✓ | clients, client_contacts, client_notes | — | — | ✓ | 9 |
| Leads / opportunities | ✓ | ✓ | leads, opportunities, pipeline_stages, sales_activities | follow-up reminders | — | ✓ | 9 |
| Support tickets | ✓ (+ portal) | ✓ | support_tickets, ticket_comments, sla_policies | SLA reminders | ✓ | ✓ | 9 |
| Quotes / agreements | ✓ | ✓ | quotes, quote_items, service_agreements | — | — | ✓ | 9 |
| Finance | ✓ | ✓ | invoices, invoice_items, payment_records, expenses, billing_rates | invoice reminders | — | ✓ | 9 |
| Leave & HR | ✓ | ✓ | leave_*, employment_documents, onboarding_* | accrual | ✓ | ✓ | 10 |
| Custom fields | ✓ | ✓ | custom_fields, custom_field_values | — | — | ✓ | 10 |
| Integrations / webhooks / API keys | ✓ | ✓ | integrations, webhooks, webhook_deliveries, api_keys | delivery | — | ✓ | 10 |
| Audit logs | ✓ | ✓ | audit_logs | archival | — | n/a | 3 (writer), 10 (UI) |
| Platform admin | ✓ | ✓ | platform_admins, support_access_grants | — | — | ✓ | 11 |
| Client portal | ✓ | ✓ | (shares CRM tables, visibility flags) | — | ✓ | ✓ | 9 |

## Out of scope for v1 (documented, not silently dropped)

- Payroll calculation and statutory filings. Exports for payroll systems are provided.
- Keystroke logging, URL/app content capture, webcam, and microphone. These are **explicitly prohibited** by design.
- Native mobile apps. The web app is responsive.
- Automated FX rates and payment provider checkout (extension points are defined).
