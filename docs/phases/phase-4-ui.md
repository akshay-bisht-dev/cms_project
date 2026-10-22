# Phase 4: App shell, dashboards and people UI (report)

**Date:** 2026-10-21 · **Status:** complete

## Objective
A usable product on top of the Phase 3 API: sign-in flows, the app shell from the reference
layout, the people directory and profiles, organization structure, dashboards showing real
metrics, and in-app plus real-time notifications.

## What was built

| Area | Details |
|---|---|
| Notifications backend | `notifications` and `notification_preferences` tables (migration `…_notifications`). In-app rows are written in the same transaction as the event. The email channel goes through the outbox. Per-type preferences. List, unread count, read, read-all and preferences endpoints. |
| Real-time | Socket.IO hub (`sockets/realtime.js`): cookie-authenticated handshakes, Origin check, server-assigned member rooms, WebSocket-only transport, and session re-validation every 60 s, which disconnects revoked sessions. Pushes run through a per-request after-commit queue, so failed requests push nothing. |
| Events that notify | Profile changed by someone else (field names only, never values), roles changed, invitation accepted (to the inviter) |
| Dashboard API | `GET /dashboard/summary`: headcount by status, active people by department, recent joiners, average profile completion, and pending invitations (invitation managers only). Scoped to `dashboard.read`. |
| Auth screens | Sign-in → two-factor (code or recovery code) → organization picker. Forgot/reset password, email verification, invitation acceptance (new or existing account), organization registration, and forced MFA setup with QR code. Safe `next` redirects only. |
| App shell | Dark purple sidebar with collapsible groups, icon-rail collapse and mobile drawer. Items are filtered by permission. Unbuilt modules are shown disabled with their phase. Top bar with organization switcher, notification bell and account menu. Skip link. |
| People | Directory with URL-driven search and filters (department, team, role, status), sortable columns, cursor pagination, CSV export, and an idempotent invite dialog |
| Profile | Header (status, meta, lifecycle actions with confirmations, role manager). 12 tabs, of which Dashboard, Profile and Activity are live and the other 9 are disabled with their phase. Field-group cards appear only when readable, edit dialogs only when editable, and edits send changed fields only. |
| Structure & settings | Departments (CRUD, archive), teams (create, lead-scoped member management), organization settings (owner-editable, read-only for others) |
| Dashboards | My Dashboard (unread notifications, profile completion, security nudge). Org Dashboard (stat tiles stating their basis, people-by-department bar chart with tooltip and screen-reader table, recent joiners). |
| Account | Sessions (revoke other devices), change password, two-factor on/off |

## Verification (run on 2026-10-21)

| Check | Result |
|---|---|
| Lint + no-TypeScript guard | pass |
| API unit / integration (real MySQL) | **61/61** · **201/201** |
| Web component tests (Vitest + RTL) | **10/10**: sidebar permission filtering, field-group visibility, login flow (errors, MFA → org picker, open-redirect guard) |
| **Playwright E2E** (real API + production web build, `orbit_e2e_test`) | **7/7** across 4 roles (owner, HR, team lead, employee): sign-in/out, generic login error, redirect when signed out, HR search and edit, employee self-service limits and a peer's private data hidden, notification delivered, owner invite, lead team scope |
| Automated accessibility (axe, WCAG 2.2 A/AA) on 6 screens | **0 serious/critical violations** |
| Visual review (screenshots at 1440px and 390px) | Layout matches the reference structure. Mobile uses a drawer and stacked filters. |

## Bugs found and fixed in this phase
1. **Profile completion was 0%** for seeded and newly registered profiles, because only the update path computed it. One `withCompletion()` helper now covers every write path, with a regression test.
2. **Accessibility:** status badge text was below 4.5:1 on its tint (tokens darkened, computed not eyeballed). Disabled nav items had a label/visible-text mismatch. The account button's name didn't include its visible initials. The toast library's success colors failed contrast. The chart was focusable inside `aria-hidden`.
3. **A real-time test race:** a socket's `ready` event could arrive before the listener attached. Fixed by capturing it at creation.

## Known limitations
- **Redis-dependent paths are still not run locally** (no Docker). The Socket.IO Redis adapter for multiple API replicas is not wired yet. With one API process, real-time works as tested.
- The manager and team pickers list the first 100 active employees. A searchable combobox is needed for larger orgs.
- No dark mode (not required for v1, per the design).
- Avatars are initials only. Photo upload needs the file service (Phase 6/10).
- 9 of 12 profile tabs, and most sidebar modules, are intentionally disabled until their phase.

## Acceptance criteria
- [x] Playwright: login → directory → profile edit across 3+ roles
- [x] axe: no serious violations on the main screens
- [x] Dashboard shows only real, backend-computed metrics, each stating its basis
- [x] Notifications: in-app, email (via outbox), real-time, read/unread, preferences
- [x] Loading, empty and error states on every data view. Destructive actions confirm.
