# Environment variables

All configuration comes from the environment. The API and worker validate their variables at startup
(`apps/api/src/config/env.js`) and exit with a list of problems rather than run half-configured.
`apps/api/tests/unit/environment-docs.test.js` fails if a validated variable is missing from this page.

**Production rules** (enforced at startup when `NODE_ENV=production`): `APP_ORIGIN` must be `https://`,
`LOG_PRETTY` must be false. Secrets come from the platform's secret store, never from files in images
(`.dockerignore` excludes every `.env*` file except `.env.example`).

## API and worker
| Variable | Required | Default | Purpose |
|---|---|---|---|
| `NODE_ENV` | | `development` | `production` enables Secure cookies, HSTS and stricter checks, and disables Swagger UI |
| `APP_ENV` | | `local` | `local`, `ci`, `staging` or `production`: appears in logs |
| `APP_ORIGIN` | prod | `http://localhost:3000` | Public URL of the web app. CORS, socket origin check, cookie `Secure`/`__Host-` prefix, links in emails |
| `PORT` | | `4000` | API HTTP port |
| `TRUST_PROXY` | | `1` | Proxy hops in front of the API (Nginx = 1, load balancer + Nginx = 2), for client IPs in rate limits and audit logs |
| `REQUEST_TIMEOUT_MS` | | `15000` | Requests running longer get 503 |
| `BODY_LIMIT` | | `100kb` | Maximum JSON body (files go straight to object storage) |
| `LOG_LEVEL` | | `info` | pino level |
| `LOG_PRETTY` | | `false` | Human-readable logs (development only) |
| `METRICS_PORT` | | `0` (off) | Internal Prometheus endpoint, `GET /metrics`. Never route it through Nginx |
| `DATABASE_URL` | ✓ | | MySQL URL of the **app** user (data reads and writes only; see `scripts/provision-db-users.js`). Append `?connection_limit=N` to size the pool |
| `DATABASE_REPLICA_URL` | | | Accepted but **not used yet**: every query goes to the primary |
| `REDIS_URL` | | `redis://localhost:6379` | Queues, rate limits, socket fan-out. Use `rediss://` for TLS |
| `REDIS_KEY_PREFIX` | | `orbit:` | Lets environments share a Redis safely |
| `S3_ENDPOINT` | | AWS | Set for S3-compatible services (SeaweedFS, MinIO, R2) |
| `S3_REGION` | | `us-east-1` | |
| `S3_ACCESS_KEY_ID` | ✓ | | Least privilege: read/write on the two buckets below only |
| `S3_SECRET_ACCESS_KEY` | ✓ | | |
| `S3_FORCE_PATH_STYLE` | | `false` | `true` for most S3-compatible services |
| `S3_BUCKET_CAPTURES` | ✓ | | Screenshots (private; lifecycle rules must not be shorter than the longest retention policy) |
| `S3_BUCKET_FILES` | ✓ | | Attachments, receipts, HR documents, invoices, report exports |
| `SESSION_SECRET` | ✓ | | ≥ 32 characters. Rotating it signs everyone out |
| `CSRF_SECRET` | ✓ | | ≥ 32 characters |
| `FIELD_ENCRYPTION_KEYS` | ✓ | | `kid:base64(32 bytes)[,older…]`: first key encrypts, all decrypt (rotation) |
| `SESSION_IDLE_MINUTES` | | `720` | Idle timeout |
| `SESSION_ABSOLUTE_DAYS` | | `14` | Absolute session lifetime |
| `RATE_LIMIT_ENABLED` | | `true` | Only switched off by load and end-to-end tests |
| `SMTP_HOST` / `SMTP_PORT` | | `localhost` / `1025` | Port 465 uses TLS |
| `SMTP_USER` / `SMTP_PASSWORD` | | | |
| `SMTP_FROM` | | `Orbit <no-reply@orbit.local>` | |
| `SENTRY_DSN` | | | Accepted but **not used yet**: errors are logged (JSON) and counted in metrics |
| `SWAGGER_ENABLED` | | on outside production | Serves `/api/docs` and `/api/openapi.json` |

## Web (Next.js)
| Variable | Purpose |
|---|---|
| `API_INTERNAL_URL` | How the Next.js server reaches the API (server-side requests; dev rewrites) |
| `NEXT_PUBLIC_REALTIME_URL` | Socket.IO origin when it differs from the page origin (development); unset in production (same origin via Nginx) |
| `CSP_STORAGE_ORIGINS` | Space-separated object-storage origins the browser may load images from and upload to (presigned URLs), e.g. `https://orbit-files.s3.eu-west-1.amazonaws.com https://orbit-captures.s3.eu-west-1.amazonaws.com` |
| `PORT`, `HOSTNAME` | Next.js server bind (image defaults: `3000`, `0.0.0.0`) |

## Operations jobs (`apps/api/scripts`)
| Variable | Used by | Purpose |
|---|---|---|
| `DATABASE_MAINTENANCE_URL` | partition-maintenance | User with `SELECT, ALTER, DROP` on the four partitioned tables only |
| `S3_BUCKET_ARCHIVE` | partition-maintenance | Where audit and screenshot-access partitions are exported before they are dropped. Unset → those partitions are kept |
| `RETENTION_ACTIVITY_MONTHS` | partition-maintenance | Default 13 |
| `RETENTION_AUDIT_MONTHS` | partition-maintenance | Default 24, minimum 12 |
| `RETENTION_ACCESS_LOG_MONTHS` | partition-maintenance | Default 24, minimum 12 |
| `RETENTION_LOGIN_ATTEMPT_MONTHS` | partition-maintenance | Default 3 |
| `PARTITION_AHEAD_MONTHS` | partition-maintenance | Months of empty partitions kept ready (default 3) |
| `BACKUP_DATABASE_URL` | backup | Backup user (`SELECT, SHOW VIEW, TRIGGER, LOCK TABLES, EVENT`, `PROCESS`) |
| `BACKUP_DIR` | backup, restore-verify | Local working directory (default `./backups`) |
| `BACKUP_AGE_RECIPIENT` | backup | `age` public key; dumps are encrypted before upload when set |
| `BACKUP_AGE_IDENTITY` | restore-verify | Path to the matching private key file (only on the restore runner) |
| `BACKUP_S3_BUCKET` / `BACKUP_S3_PREFIX` | backup | Off-site copy (default prefix `mysql/`), using the `S3_*` credentials |
| `BACKUP_KEEP_LOCAL` | backup | Local dumps kept (default 3) |
| `MYSQLDUMP_BIN` / `MYSQL_BIN` | backup, restore-verify | Client binaries if not on `PATH` |
| `RESTORE_ADMIN_URL` | restore-verify | Account allowed to create and drop the scratch `orbit_restore_verify_*` database (an isolated restore server) |
| `RESTORE_MAX_DRIFT_PCT` | restore-verify | Allowed row-count difference for backups of a live database (default 0) |
| `RESTORE_KEEP` | restore-verify | `true` keeps the scratch database for inspection |
| `DATABASE_ADMIN_URL` | provision-db-users | Admin account that creates the least-privilege users |
| `DB_APP_PASSWORD`, `DB_MIGRATE_PASSWORD`, `DB_MAINTENANCE_PASSWORD`, `DB_BACKUP_PASSWORD`, `DB_READONLY_PASSWORD` | provision-db-users | One per user to create or rotate (20–128 characters of a base64 alphabet) |
| `DB_NAME`, `DB_USER_PREFIX`, `DB_USER_HOST`, `DB_REQUIRE_TLS` | provision-db-users | Defaults: database from the URL, `orbit`, `%`, `false` |

## Development and tests only
`DATABASE_URL_TEST` (name must end in `_test`), `DATABASE_URL_E2E` (`_e2e_test`), `DATABASE_URL_E2E_APP`
(least-privilege API user for end-to-end runs), `SHADOW_DATABASE_URL` (Prisma), `SEED_PASSWORD`,
`DATABASE_URL_PERF` (`_perf_test`), `PERF_*` and `PROFILE_MIN_MS` (docs/performance.md), `NEXT_DIST_DIR`,
`TEST_LOG_LEVEL`, `CI`. `ORBIT_SERVICE` is set by the images (`api`, `worker`) and labels logs.
