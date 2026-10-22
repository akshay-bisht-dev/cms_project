# Phase 10: HR, leave & integrations (report)

**Date:** 2026-10-22 · **Status:** complete (accrual, carry-over and webhook-delivery schedules not yet run on a real Redis worker)

## Objective
Leave management on a ledger, HR documents, onboarding and offboarding checklists, custom fields,
signed webhooks with retries and replay, scoped API keys, an audit-log UI, and the remaining settings
pages. The acceptance criteria require leave balance and overlap tests, and webhook signature and
replay-protection tests.

## What was built
- **Schema** (migration `20261021160959_hr_leave_integrations`):
  - **Leave:** leave types, policies (accrual NONE/MONTHLY/ANNUAL, cap, carry-over, negative allowed, approval chain), policy assignments, ledger entries, requests (half-day slots), approvals.
  - **HR:** employment documents, checklist templates, checklists and tasks.
  - **Platform:** custom fields and values, webhooks, webhook deliveries, API keys.
  - `AttendanceStatus` gains `LEAVE`.
  - **Database guarantees:**
    - triggers make `leave_ledger_entries` append-only (no UPDATE or DELETE) and `leave_approvals` immutable;
    - CHECKs: ledger days in multiples of 0.5 and non-zero; `end_date ≥ start_date`;
    - unique idempotency keys on ledger entries (accruals and carry-over can't double-post);
    - unique fan-out key per webhook and event (one delivery per subscriber).
- **Leave:**
  - **Balance** = the sum of ledger entries for the year. Pending requests reduce *available*, not the balance.
  - **Defaults** are created on first use: Annual (20 days a year, 5 carry over, manager → HR), Sick (10), Unpaid (may go negative).
  - **Policy precedence:** member > team > department > the type's default.
  - **Day counting:** working days at half-day precision. A day counts when the member's schedule has hours that day (or Monday–Friday when no schedule exists), minus holidays; half-day holidays count ½.
  - **Requests:**
    - overlap is checked at half-day precision under a per-member row lock, so concurrent requests can't both succeed;
    - the balance is checked unless the policy allows negative;
    - a live preview returns days, available and after-request.
  - **Approval chain:** steps are MANAGER, TEAM_LEAD or HR. Each step is resolved to people when requested; empty steps are skipped, and requesters never approve their own. Rejection needs a comment. Approval books a usage entry.
  - **Cancellation:** the owner can cancel before the leave starts, HR at any time. Cancelling approved leave posts a reversing ledger entry.
  - **Jobs:**
    - `leave-accruals` runs daily at 01:15 UTC. Accruals are idempotent per period, and the cap is applied.
    - Carry-over at the year end keeps up to `carryOverMaxDays` and expires the rest. An empty limit means nothing carries.
  - **Integration with existing modules:** approved leave marks attendance `LEAVE` instead of `ABSENT`; the daily rollup removes leave from scheduled time; leave appears in the unified calendar.
- **HR documents:**
  - private presigned uploads; visibility HR only or shared with the employee;
  - 60-second download links, each download audited;
  - an expiring and expired list;
  - employees see only their own shared documents (others → 404).
- **Checklists:**
  - onboarding starts automatically when an employee is created, offboarding on offboarding;
  - template tasks go to HR, the manager or the employee, with due-day offsets;
  - only a task's assignee (or HR) completes it.
- **Custom fields:**
  - on employees, projects, tasks, clients and tickets;
  - typed values: text, number (4 dp), date, select, multi-select, boolean; required fields enforced;
  - reading and writing follow the record's own access rules;
  - `meta.canEdit` tells the UI whether to offer editing.
- **Webhooks:**
  - 13 domain events emitted through the outbox in the same transaction as the change.
  - Signatures: HMAC-SHA256 over `timestamp.deliveryId.body`. The secret is encrypted at rest, shown once and rotatable.
  - Retries at 1 min, 5 min, 30 min, 2 h and 12 h; disabled after 20 consecutive failures.
  - Deliveries are claimed with `SKIP LOCKED` and a lease; replay gets a new delivery id and signature; a test ping.
  - SSRF guard: HTTPS only in production, no credentials in URLs, private, loopback, link-local, CGNAT and metadata addresses refused **at connect time** (the DNS answer is checked), no redirects.
- **API keys:**
  - format `orb_<prefix>_<secret>`; only a SHA-256 hash is stored;
  - scopes must be permissions the creator holds, and each request uses the creator's *current* permissions ∩ the key's scopes;
  - accepted only on routes declared `apiKey: true` (18 read routes plus ticket creation), marked `x-api-key` in OpenAPI;
  - 1000 requests/hour per key; expiry and revocation; the audit actor is `API_KEY`;
  - sending a key and a session together is refused.
- **Audit log API:** cursor list with action-prefix, actor, target and time filters; actors resolved to names.
- **UI:**
  - **Time Off** (my leave with balances, To approve, Team) and a request dialog with a live preview.
  - **Settings:** Leave (policies, assignments, types), Custom fields, Integrations (webhooks with deliveries, test, replay, rotate and turn off; API keys created once and revoked).
  - **Audit Logs** page with filters and "load more".
  - **Documents** (expiring) and **Checklists** (my tasks).
  - **Employee profile tabs:** Time Off, Documents (documents and checklists), Integrations (own API keys), and custom fields on the Profile tab.
  - Custom fields also appear on project overview, client, task and ticket pages.
  - Every sidebar module is now built; the "available in Phase N" placeholders are gone.
  - Settings tabs keep the active tab scrolled into view on phones.

## Verification (run on 2026-10-21/22)
| Check | Result |
|---|---|
| Lint + no-TS guard | pass |
| API unit | **108/108** (+4 leave days, +5 webhook signatures and SSRF) |
| API integration (real MySQL) | **1389/1389** (+8 leave, +10 integrations); generated permission suites extended with "API key refused on every non-`apiKey` route"; OpenAPI asserts `x-api-key` |
| Desktop agent / web unit | **34/34** · **17/17** |
| Next build | pass (also rebuilt by the E2E run) |
| Playwright E2E + axe | **31/31** (+6 hr-integrations: request with preview → manager then HR approve → employee sees it; HR policies, custom field defined and filled on a profile; webhook and API key secrets shown once, key revoked, both audited and filtered; employee blocked from audit logs. Auth spec updated (Time Off is now a link)) |
| Visual review | Time Off, request dialog, Leave settings, Custom fields, Integrations, Audit logs, Documents at 1280 px and 390 px |

The `infra` project (real Redis and S3 via docker compose) was not run; Docker is not available here.

## Bugs found and fixed
1. **Leave counted 0 days for members without a work schedule.** When no schedule was assigned and the organization had no default, every date counted as non-working, so leave could not be requested at all. The integration tests always created a schedule; the E2E seed doesn't, which exposed it. Days now fall back to Monday–Friday, and a regression test covers this.
2. **Hooks registered per app instance:** the employee-created and offboarding hooks were added on every `createServices` call (duplicate checklists and events in tests). They are now registered once per process.
3. **Leave policy MEMBER targets** used the membership id; they now take the employee id, like every other API.
4. **Audit-log pagination** returned `meta.nextCursor`; it now uses `meta.page.nextCursor` like other cursor endpoints.
5. **UI:** the delivery status badge expected `DELIVERED`, but the API returns `SUCCEEDED`. The custom-field form's "On" label was ambiguous (it also collided with other names) and is now "Record type".
6. **Test database reset timed out.** `resetDatabase` truncates every table inside an interactive transaction with Prisma's default 5 s timeout; the new tables pushed it over, failing whole suites (monitoring, health) before any test ran. The timeout is now 60 s (test helper only).

## Limitations
- **Not run on real infrastructure:** accrual, carry-over and delivery jobs are tested as functions, but their BullMQ schedules haven't run on Redis. HR document uploads to real S3 are untested (in-memory store).
- **Webhook receivers:** delivery is at least once. The reference `verifyWebhook` records the delivery id when it verifies; receivers that may fail afterwards should record it after handling (documented in [integrations.md](../integrations.md)).
- **Not built:**
  - packaged third-party connectors (`/integrations`; the permission is reserved);
  - leave encashment, comp-off and accrual pro-rating for mid-period joiners;
  - leave reports;
  - e-signature for HR documents;
  - expiry reminders for documents (the list exists; there are no notifications).
- Custom fields can't yet be used as list filters or report columns.

## Acceptance criteria
| Criterion | Status |
|---|---|
| Leave balance tests | ✅ ledger accrual idempotency, cap, carry-over, negative policy, cancellation reversal, HR adjustments |
| Leave overlap tests | ✅ half-day precision, including concurrent requests (exactly one succeeds) |
| Webhook signature tests | ✅ genuine, tampered body, wrong secret, altered headers; verified end to end on real deliveries |
| Webhook replay protection | ✅ stale timestamps and reused delivery ids rejected; replays get a fresh id and signature |
