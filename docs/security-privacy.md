# Security & Privacy Architecture

## 1. Threat model (STRIDE summary)

| Asset | Main threats | Primary controls |
|---|---|---|
| Accounts / sessions | Credential stuffing, session theft, CSRF | Argon2id, lockout + IP rate limits, MFA, HttpOnly/Secure/SameSite cookies, double-submit CSRF, session revocation |
| Tenant data | Cross-org access (IDOR), privilege escalation | Composite FKs, mandatory `orgId` in repositories, scoped RBAC on every call, 404 for foreign IDs, deny-only overrides, SoD rules |
| Screenshots | Leakage, unauthorized viewing, covert capture | Private bucket, 60 s signed URLs, access logs, consent gating, visible agent, legal-hold-aware retention |
| HR / finance data | Over-exposure | Field-group serializers, app-level encryption of sensitive columns, separate finance permissions |
| Agent | Stolen device token, malicious uploads | Device key in keychain, 15-min tokens, revocation, presign constraints, server-side image re-encode |
| Integrations | Secret theft, webhook spoofing, SSRF | AES-GCM encrypted secrets, HMAC signatures + timestamp, egress URL validation (no private IPs), scoped API keys |
| Platform | Insider (support) abuse | Owner-approved, time-boxed support grants. Everything audited. |
| Availability | Abuse, expensive queries | Rate limits, request timeouts, bounded sync reports, job quotas |

## 2. Authentication details

| Control | Setting |
|---|---|
| Password hashing | Argon2id (`@node-rs/argon2`, prebuilt for all target platforms). m=19456 KiB, t=2, p=1 (OWASP baseline). Parameters stored in the hash for future rehash on login. |
| Password policy | ≥ 12 chars, checked against a local top-100k breached list. No composition rules. |
| Rate-limit store | Redis in deployed environments (shared across replicas), memory in tests. The limiter **fails open** if Redis is unreachable (logged), so a cache outage cannot take the API down. Login brute force stays bounded by the database lockout below. |
| Lockout | 5 failures → 15 min account lock (exponential up to 24 h). IP limit 20/min. Generic "invalid credentials" response. Constant-time comparison path for unknown users (dummy hash). |
| Session token | 32 random bytes, base64url. Only the SHA-256 is stored. Cookie `orbit_sid`: HttpOnly, Secure, SameSite=Lax, Path=/, `__Host-` prefix in production. |
| Session lifetime | Idle 12 h, absolute 14 days (`SESSION_IDLE_MINUTES`, `SESSION_ABSOLUTE_DAYS`). The token is rotated on MFA verification/enrolment, password change, and org switch. Each request loads the session and permissions from MySQL (about 5 indexed queries). A Redis cache is a later optimization. |
| CSRF | Double-submit: `__Host-orbit_csrf` (readable) = HMAC(sessionId, secret). Required in `X-CSRF-Token` for unsafe methods. The Origin header is also checked against the allow-list. |
| MFA | TOTP (RFC 6238, `otplib`), secret encrypted at rest, 10 single-use recovery codes (hashed). Step-up MFA for sensitive actions (role changes, API keys, data export) when enabled. |
| Tokens (email) | 32 random bytes, hashed, single use, TTLs: verify 24 h, reset 30 min, invite 7 d |

## 3. HTTP & platform hardening

- **Helmet** with a strict CSP from Next.js middleware (nonce-based `script-src`, `img-src 'self' https://<bucket-host>`, `connect-src 'self' wss://<host>`), `frame-ancestors 'none'`, HSTS (preload-ready), `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` that disables camera, mic, and geolocation.
- **CORS:** same-origin by design, so the API allows no cross-origin browser requests except an explicit allow-list (empty by default). The agent is not a browser and is unaffected.
- **Limits:** JSON body 100 KB (1 MB on bulk endpoints), URL 8 KB, 15 s request timeout, Nginx `client_max_body_size 2m` (files go direct to S3).
- **Validation:** Zod on params, query, and body. Unknown keys are rejected (`.strict()`). Rich text (comments, descriptions) is sanitized server-side (DOMPurify via `isomorphic-dompurify`) to a markdown-safe subset.
- **Files:** presigned uploads with content-type and length constraints. MIME is verified by magic bytes on complete. Optional ClamAV scan job for documents. Downloads use `Content-Disposition: attachment` for non-images.
- **SSRF:** webhook and integration URLs must be HTTPS and resolve to public IPs (checked again at delivery time). Redirects are not followed.
- **Errors:** production responses carry only `code`, `message`, `requestId`. Stack traces go to logs and Sentry only. Prisma errors are mapped (P2002 → 409 CONFLICT, P2025 → 404).
- **Logging hygiene:** pino `redact` covers `password`, `token`, `authorization`, `cookie`, `secret`, `*.emergencyContact`, presigned URLs. No request bodies on auth routes.
- **Secrets:** environment-only, validated at boot by Zod. Production pulls them from the platform's secret manager. `.env` is never committed. Field encryption keys are versioned (`kid` prefix on ciphertext) for rotation.
- **Dependencies:** lockfile, `pnpm audit` in CI, Dependabot, pinned base images, non-root containers, read-only root filesystem where possible.

## 4. Authorization implementation

```js
// route declaration
r.post('/:timesheetId/approve', {
  params: idParams, body: approveSchema,
  permission: 'timesheets.approve', idempotent: true, rateLimit: 'write',
}, ctl.approve);

// service
async approve(ctx, { timesheetId, comment }) {
  return tx(async (db) => {
    const ts = await repo.lockById(db, ctx.orgId, timesheetId);       // 404 if not in org
    await rbac.assertCovers(ctx, 'timesheets.approve', { userId: ts.userId }); // scope check
    if (ts.userId === ctx.userId) throw new Forbidden('SELF_APPROVAL');
    // … state machine, approval row, audit, outbox
  });
}
```
- `authorize` middleware does a fast check (the member has the permission at *any* scope). Services perform the **target-aware** scope check. Both are required, and a test helper asserts every route declares a permission.
- List endpoints apply scope as a **query filter** (`where userId IN scopeSet`), never as post-filtering in memory.

## 5. Audit logging

Audited actions include: login/logout/failures (summary), MFA changes, password changes,
session revocations, role and permission changes, member lifecycle, sensitive profile
field changes, policy publishes, consent events, agent register/revoke, screenshot
view/download/delete, legal holds, timesheet and leave decisions, attendance corrections,
time-entry edits on locked periods, invoice issue/void/payment, rate changes, exports,
integrations, webhooks, API keys, support-grant access, settings changes.
Records are append-only (DB triggers), include the request ID, and can be exported.

## 6. Privacy design

| Principle | Implementation |
|---|---|
| Purpose limitation | Monitoring data serves work verification and billing evidence only. The notice text states the purposes, and the policy UI requires the owner to confirm them. |
| Minimization | No keystrokes, clipboard, URLs, window titles (v1), audio, or video. Blur and exclusions are available. Idle = duration only. |
| Transparency | Employee `/monitoring` page. Every metric is labelled measured, derived, or estimated. Employees see their own screenshots and who viewed them (configurable, on by default). |
| Notice & acknowledgement | Versioned notice with an acknowledgement record (time, IP, notice hash). Withdrawal is supported. |
| Retention | Enforced by jobs (see database-design §5). Shortening at lower policy levels only. |
| Access & portability | Subject-access export job (profile, attendance, time, screenshots metadata + images, leave) as a ZIP via a signed URL |
| Erasure | Erasure request workflow: anonymize the user (name → "Former employee #code", email hashed), delete sensitive fields, screenshots, documents, and sessions. Keep financial and timesheet records with the anonymized reference where legally required. |
| Sensitive data | Emergency contacts, personal email, address encrypted at the column level. Visible only to HR + self by default. |
| Org responsibility | Settings pages show a jurisdiction notice: the org must ensure its monitoring is lawful (e.g. GDPR Art. 6/88, works-council agreements, local consent laws) before enabling it. |

## 7. Security checklist (gate for each release)

- [ ] Every route declares a permission (automated test)
- [ ] Cross-org access test suite green (one test per resource type)
- [ ] No secrets in repo (gitleaks in CI)
- [ ] `pnpm audit --prod` has no high/critical issues, or each one is triaged with an ADR
- [ ] CSP/headers verified with an automated header test
- [ ] Rate limits verified on auth endpoints
- [ ] Backups restored successfully in the last 7 days
- [ ] Error responses sampled: no stack traces or internals
- [ ] Desktop agent build signed and notarized. Update signature verified.
