# Phase 3: Identity, organizations and employees (report)

**Date:** 2026-10-21 · **Status:** complete (backend). The screens for these features arrive in Phase 4.

## Objective
Real authentication and authorization, enforced on the server, for every later module:
sessions, MFA, RBAC with scopes, tenant isolation, organization structure, and the employee
directory with field-level access.

## What was built

| Area | Files |
|---|---|
| Schema | Migration `…_identity_rbac_org_structure`: organization_settings, employee_profiles, profile_change_history, departments, teams, team_members, permissions, roles, role_permissions, member_roles, member_permission_overrides, invitations, auth_tokens, mfa_settings, login_attempts. **15 composite tenant FKs.** |
| Tenant guard | `repositories/tenant-guard.js`: a Prisma extension that throws on any unscoped query against the 13 tenant models (outside production). `prisma.unscoped` is the explicit escape hatch. |
| Request pipeline | `middleware/session.js` (session → user → membership → org settings → effective permissions), `csrf.js`, `authorize.js` (`PUBLIC`/`SESSION`/`MEMBER`/permission key), `idempotency.js`, `rate-limit.js` |
| Core services | `passwords.js` (Argon2id), `totp.js` (RFC 6238), `crypto.js` (tokens, HMAC, AES-256-GCM field cipher with key rotation), `audit.js` (redacting), `outbox.js`, `email.js`, `rate-limiter.js`, `clock.js` |
| Auth | Login with lockout, org selection, logout, `/me`, session list/revoke, change password, forgot/reset, verify email, invitation preview/accept, TOTP setup/enable/verify/disable with recovery codes |
| RBAC | `modules/rbac`: 87-permission catalog (synced on boot), 7 system role templates from the matrix, scope resolution (self/team/department subtree; project is empty until Phase 6), anti-escalation guard, last-owner guard, deny overrides |
| Org & structure | Registration (creates the org, settings, roles, and an owner who must verify their email), profile, settings sections (attendance, timeTracking, security, profile), departments (tree, cycle check), teams (lead-managed membership) |
| Employees | Directory (search, filters, signed keyset cursor), CSV export (formula-safe, ≤ 5k rows), create/bulk invite, profile with 7 field groups, encrypted sensitive fields, change history (sensitive values redacted), activate/deactivate/offboard/archive, invitations (list/resend/revoke), seat limit, reporting-cycle check |
| Worker | Outbox relay (`FOR UPDATE SKIP LOCKED`, jobId = outbox id), email job (nodemailer), maintenance purges |
| Docs | OpenAPI 3.1 generated from route declarations: `/api/openapi.json`, Swagger UI at `/api/docs`, committed `openapi/openapi.json` with a drift test. 57 operations. |
| Seed | Idempotent. 2 orgs × (owner + HR, PM, team lead, 2 employees, finance), 3 departments, 1 team. Backfills roles for pre-RBAC orgs. |

## Permission rules worth knowing
- Every route declares its access level. A generated test proves that all 57 routes return **401** without a session, and that every permission-gated route returns **403** for a member with no roles.
- Field groups (`basic`, `work`, `contact`, `personal`, `emergency`, `employment`, `security`) are each read and updated under their own permission. Responses list `access.readableGroups` / `editableGroups` for the UI.
- Employees edit their own contact, personal and emergency fields. Organizations can switch that off per group (`settings.profile.selfServiceFields`).
- HR can invite people with the baseline Employee role, or with roles whose grants HR already holds. Only owners can grant Owner, and an organization can never lose its last active owner.

## Verification (run on 2026-10-21, real MySQL 8.4.10)

| Check | Result |
|---|---|
| Lint + no-TypeScript guard | pass |
| API unit tests | **61/61** |
| API integration tests (real DB) | **185/185** across 11 files |
| Web tests / production build | 3/3 · pass |
| Mutation check: disable CSRF session binding | 2 CSRF tests fail as expected, then restored |
| Live server smoke test (curl with cookie jar) | HR login → `/me` (44 permissions) → paginated directory → invite blocked without CSRF, 201 with it → employee gets 403 on department create → Swagger UI 200 |

Mandatory cases from the brief that are covered now: valid/invalid login, expired sessions,
revoked sessions, permission-denied operations, cross-organization access (API and DB level),
export permissions, employee offboarding, concurrent updates (single-use tokens and invitations
use conditional updates).

## Bugs found and fixed by the tests
1. The anti-escalation rule blocked HR from assigning even the default Employee role. Fixed with a documented baseline-role exception.
2. The outbox relay compared a DB-default timestamp with the app clock. Fixed so it compares against the DB clock.
3. A signed-but-malformed pagination cursor could raise a 500. It now returns 400.

## Known limitations
- **Redis is still unverified locally** (no Docker). The Redis rate-limit store, BullMQ queues and the worker's live loop have been reviewed but never run. CI and `test:infra` will be their first real run.
- Session and permission data are read from MySQL on each request (about 5 indexed queries). A Redis cache is a later optimization.
- `project` scope resolves to "self only" until projects exist (Phase 6).
- MFA enforcement is organization-wide (`security.mfaRequired`), not yet per role.
- There's no UI yet. Login, directory and profile screens are Phase 4.
- The platform super-admin and support-access grants are scheduled for Phase 11.

## Acceptance criteria
- [x] Authentication and sessions are enforced, with CSRF, lockout and MFA
- [x] RBAC with scopes, deny overrides and the escalation guard, enforced in the backend on every route
- [x] Organization data is isolated by query scoping, a runtime guard and DB composite FKs (all tested)
- [x] Departments, teams and the employee directory/profile APIs work end to end
- [x] Sensitive fields are encrypted at rest. The audit log covers sensitive actions.
- [ ] Redis-backed paths are verified: **pending Docker or CI**
