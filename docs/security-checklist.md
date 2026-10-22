# Security checklist

Status of every control, with where it is enforced and how it is verified. Re-check before each major
release; [release-checklist.md](release-checklist.md) links here. The threat model is in
[security-privacy.md](security-privacy.md).

Legend: ✅ in place and tested · 🟡 in place, verification limited (noted) · ⬜ not done

## Identity and sessions
| Control | Status | Enforcement | Verified by |
|---|---|---|---|
| Passwords hashed with Argon2id; strength rules | ✅ | `services/passwords.js` | auth integration tests |
| Login lockout per account, rate limits per IP + account | ✅ | DB lockout; `auth-strict` limit; Nginx 5 r/s edge limit | auth tests, `rate-limit.test.js` |
| Rate limits survive a Redis outage | ✅ | In-memory fallback, bounded to 100k keys (Phase 11) | `rate-limit.test.js` |
| TOTP MFA, enforceable per organization | ✅ | `services/totp.js` | `totp.test.js`, `mfa.test.js` |
| Opaque server-side sessions; only the SHA-256 is stored | ✅ | `session.service.js` | auth tests |
| Idle and absolute session timeouts; revocation on password change and offboarding | ✅ | session service | auth and employee tests |
| Cookies `HttpOnly`, `Secure`, `SameSite=Lax`, `__Host-` prefix over HTTPS | ✅ | `cookieNames`, `cookieOptions` | auth tests |
| CSRF: HMAC-bound double-submit token on unsafe methods | ✅ | `middleware/csrf.js` | generated permission suite, auth tests |
| API keys hashed, scoped ⊆ the creator's current permissions, expiring and revocable, only on opted-in routes | ✅ | `integrations/api-keys.js` | API-key suite in the generated permission tests |

## Authorization and tenancy
| Control | Status | Enforcement | Verified by |
|---|---|---|---|
| Every route declares its permission | ✅ | `defineRoutes` | Generated suite: 401/403 for **every** route (327 operations) |
| Client-portal users refused on internal routes | ✅ | `allowClient` flag | Generated suite, every route |
| Agent tokens cannot act as sessions; API keys only on `apiKey` routes | ✅ | `authorize.js` | Generated suite, every route |
| Tenant isolation: unscoped queries rejected; composite FKs keep children in their organization | ✅ | `tenant-guard.js` (dev/test), schema FKs | Cross-organization tests; guard on in all tests |
| Field-level visibility (personal, emergency, employment fields) | ✅ | employee serializers | employee tests |

## Input, output and HTTP
| Control | Status | Enforcement | Verified by |
|---|---|---|---|
| Strict Zod validation of params, query and body | ✅ | `defineRoutes` | `routing.test.js`; 400s asserted throughout the integration suites |
| Error envelope without stack traces or internals; request IDs | ✅ | `error-handler.js` | `http.test.js` |
| API headers: CSP `default-src 'none'`, nosniff, frame denial, CORP, HSTS (production), `Cache-Control: no-store` | ✅ | helmet in `app.js` | `http.test.js` |
| **Web app CSP with a per-request nonce**, `strict-dynamic`, no `unsafe-eval` in production; nosniff, `X-Frame-Options: DENY`, referrer and permissions policies | ✅ (Phase 11; none before) | `apps/web/src/proxy.js`, `next.config.mjs` | `csp.test.js`; E2E checks headers and nonce, and **fails on any CSP violation** across all 32 tests |
| Body size limits (100 kb API, 2 MB edge) | ✅ | Express, Nginx | `http.test.js` |
| Socket.IO: origin checked, session re-validated periodically | ✅ | `sockets/realtime.js` | `notifications.test.js` (foreign origin, no session, revoked session) |

## Data protection
| Control | Status | Enforcement | Verified by |
|---|---|---|---|
| Sensitive profile fields encrypted (AES-256-GCM, key rotation) | ✅ | `services/crypto.js` | `crypto.test.js`, `employees.test.js` |
| Screenshots and files private; 60 s signed URLs; every view logged | ✅ | storage service, monitoring module | monitoring tests |
| Webhook SSRF guard (private, loopback, link-local, CGNAT, metadata) checked at connect time | ✅ | `integrations/ssrf.js` | unit and integration tests |
| Uploads verified (size, type, image decoding) before acceptance | ✅ | files, monitoring | `monitoring.test.js`, `projects.test.js`, `integrations.test.js` |
| Append-only audit, ledgers, approvals and consents (database triggers) | ✅ | migrations | `finance`, `timesheets`, `monitoring`, `activity-reports`, `partitions` tests; `backup.test.js` (bodies restorable); restore drill |
| Retention enforced: screenshots, sessions, tokens; activity, audit, access and login logs by partition | ✅ (Phase 11 for partitions) | worker jobs, `partition-maintenance` | `partitions.test.js` |
| Audit history is archived (verified count) before any drop | ✅ | `jobs/partitions.js` | `partitions.test.js` |
| Logs redact secrets and personal data | ✅ | `config/logger.js` | `logger.test.js` (Phase 11) |

## Infrastructure
| Control | Status | Enforcement | Verified by |
|---|---|---|---|
| **Least-privilege database users** (app: DML only; separate migrate, maintenance, backup, read-only) | ✅ (Phase 11) | `scripts/provision-db-users.js` | Full E2E suite run with the API on the DML-only user (31/31); probes show `TRUNCATE`/`DROP PARTITION` denied |
| Secrets only from the environment / secret manager; `.env*` excluded from images | ✅ | `.dockerignore`, `check-deploy` rejects committed Secrets and inline secret values | `check-deploy.mjs` (mutation-tested) |
| Containers non-root, read-only, all capabilities dropped, seccomp default, no service-account token | 🟡 | compose and Kubernetes manifests | `check-deploy.mjs`; not yet started on a real cluster |
| Network: only Nginx/Ingress exposed; data stores internal; default-deny ingress policies | 🟡 | compose networks, NetworkPolicies | `check-deploy.mjs`; not exercised on a cluster |
| TLS 1.2/1.3, modern ciphers, HSTS, OCSP stapling | 🟡 | `nginx/production/orbit.conf.template` | Reviewed; `nginx -t` not run here |
| Images scanned (Trivy: fixable critical/high fails the build), signed (cosign), with SBOM and provenance | 🟡 | `ci.yml`, `release.yml` | Workflows written; first run happens on GitHub |
| Production dependencies free of known vulnerabilities | ✅ | `pnpm audit --prod` in the weekly scan | Clean on 2026-10-22 after overriding `deepmerge-ts` (GHSA-ggr8-5vv4-36mx, via Prisma's config loader) |
| Backups encrypted (`age`), off-site, restore verified weekly | ✅ / 🟡 | `scripts/backup/*` | Restore drill on 1.4 M rows; encryption path not exercised locally (no `age` binary) |
| Metrics port internal only | ✅ | separate server; not routed by Nginx/Ingress | `metrics.test.js` (only `GET /metrics` answered) |

## Monitoring transparency (product rule)
| Control | Status | Verified by |
|---|---|---|
| No capture without an active policy and the employee's acknowledgement; visible agent; no capture while clocked out or on a break | ✅ | `monitoring.test.js`, desktop-agent tests |
| Policy changes need re-acknowledgement; consent history immutable | ✅ | `monitoring.test.js` |

## Accepted findings
| Finding | Decision |
|---|---|
| `braces` (high, ReDoS) via `@next/eslint-plugin-next` › fast-glob; `sprintf-js` (moderate) via electron-builder | Development tooling only, never shipped, and no patched version exists. Re-check monthly |
| ZAP rule 10049 (non-storable content) | `no-store` on API responses is intended |
| Styles allow `'unsafe-inline'` in the web CSP | Charts, toasts and dialogs set style attributes. Inline *scripts* stay blocked |
| `SENTRY_DSN`, `DATABASE_REPLICA_URL` accepted but unused | Documented as not built ([environment.md](environment.md)) |

## Not done (needs an environment or a decision)
- ⬜ A dynamic scan (OWASP ZAP baseline) against a deployed staging environment: the workflow exists
  (`security-scan.yml`), but no staging environment is up yet.
- ⬜ An external penetration test before the first customer goes live.
- ⬜ Apple and Windows code-signing certificates (they must be purchased) to ship signed agents.
