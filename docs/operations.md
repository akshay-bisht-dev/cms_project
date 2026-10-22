# Operations

Day-to-day running of Orbit in production: health, metrics, alerts, scheduled work and logs.
Deployment is in [deployment-guide.md](deployment-guide.md), recovery in [backup-restore.md](backup-restore.md),
and fixing things in [troubleshooting.md](troubleshooting.md).

## Health
| Endpoint | Meaning | Used by |
|---|---|---|
| `GET /api/v1/health/live` | The process is up | Liveness probes, container `HEALTHCHECK` |
| `GET /api/v1/health/ready` | Database, Redis and object storage reachable | Readiness probes; the release smoke test |
| `GET /healthz` (Nginx) | The edge is up | Load balancer |

## Metrics
Set `METRICS_PORT` (the manifests use 9464) and scrape `GET /metrics` on API and worker pods. Name the
scrape jobs `orbit-api` and `orbit-worker`, because `OrbitApiDown` looks for `job="orbit-api"`. The port
is internal: Nginx and the Ingress never route it, and a NetworkPolicy admits only the `monitoring`
namespace.

| Metric | Source | Notes |
|---|---|---|
| `http_request_duration_seconds{method,route,status_class}` | API | Histogram; `route` is the matched pattern (`/api/v1/employees/:employeeId`), never a raw URL |
| `queue_jobs{queue,state}` | worker | waiting / active / delayed / failed, read at scrape time |
| `job_duration_seconds{queue,name}`, `job_failures_total{queue,name,final}` | worker | `final="true"`: retries exhausted |
| `outbox_pending`, `outbox_oldest_pending_seconds` | worker | Due events not yet published (notifications, emails, webhooks) |
| `webhook_deliveries_pending` | worker | Waiting or retrying |
| `metrics_source_up{source}` | worker | 0 when Redis or the database could not be read for the scrape |
| `process_*`, `nodejs_*` | both | prom-client defaults: memory, event-loop lag, GC |

Alert rules: [`infrastructure/monitoring/alert-rules.yml`](../infrastructure/monitoring/alert-rules.yml)
cover API latency (p95 > 500 ms for 10 min), 5xx > 1 %, no API scraped, jobs failing after retries,
queue backlog, outbox lag > 2 min, the worker unable to read its sources, a webhook backlog, any failed
scheduled job, no backup in 26 h, and no verified restore in 8 days.

Not built: error tracking (Sentry is declared in the configuration but not wired; errors are in the JSON
logs and the 5xx metric) and tracing.

## Scheduled work
| Job | Schedule (UTC) | Where | Notes |
|---|---|---|---|
| `mysql-backup` | daily 01:30 | CronJob / host timer (ops image) | [backup-restore.md](backup-restore.md) |
| `mysql-restore-verify` | Sunday 04:00 | CronJob / host timer | Restores the newest backup on an isolated server |
| `partition-maintenance` | daily 02:15 | CronJob / host timer | Creates partitions 3 months ahead; archives then drops expired months |
| Stats rollups (`stats-dirty` every 5 min, `stats-nightly` 00:30) | | worker | Daily member stats |
| Screenshot retention | daily 02:00 | worker | Honors legal holds |
| Leave accruals and carry-over | daily 01:15 | worker | Idempotent per period |
| Missed clock-outs, absences, overdue tasks, SLA breaches, webhook deliveries, outbox and token purges | various | worker | `apps/api/src/worker.js` |

With Docker Compose, use host timers for the ops jobs, for example a systemd timer running
`docker compose -f docker-compose.prod.yml --profile ops run --rm backup`. Alert when the unit fails
(`OnFailure=`).

## Data retention (enforced)
| Data | Retention | Mechanism |
|---|---|---|
| Activity events | 13 months (`RETENTION_ACTIVITY_MONTHS`) | Monthly partitions dropped by `partition-maintenance`; rollups are kept |
| Audit log | 24 months (`RETENTION_AUDIT_MONTHS`, ≥ 12) | Partition exported to `S3_BUCKET_ARCHIVE` as gzip JSONL, row count verified, then dropped. Without an archive bucket nothing is dropped |
| Screenshot access log | 24 months (`RETENTION_ACCESS_LOG_MONTHS`, ≥ 12) | As the audit log |
| Login attempts | 3 months (`RETENTION_LOGIN_ATTEMPT_MONTHS`) | Partition drop |
| Screenshots | Per monitoring policy (default 90 days) | Worker job, with deletion log and legal holds |
| Sessions, tokens, idempotency keys, published outbox events | 7–180 days | Worker maintenance jobs |

Partitions are monthly, so data is kept for *at least* the configured period and up to a month longer.
The maintenance job runs as its own database user with `ALTER, DROP` on those four tables only. The
application user cannot drop partitions, so it cannot remove audit history this way.

## Logs
JSON lines to stdout (pino). Every request log has `requestId` (echoed as `X-Request-Id`, also in error
responses), `service`, `env`, method, URL, status and latency. Personal data and secrets are redacted by
the logger configuration. Ship them with the platform's collector; keep 30 days hot, 1 year cold.

## Capacity guide
One API process served 126 requests/s at p95 334 ms on the test dataset ([performance.md](performance.md)).
Start with 2 API replicas (autoscale on CPU 65 %, max 10), 2 web, 2 workers, and MySQL with at least
8 GB of buffer pool for 300–1,000 employees. Watch `outbox_oldest_pending_seconds` and
`queue_jobs{state="waiting"}` to size workers.
