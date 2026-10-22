# Troubleshooting

Start from the symptom. Every error response carries a `requestId`; search the logs for it first.

## API not ready
`/api/v1/health/ready` lists which dependency failed (`database`, `redis`, `storage`).
- **database:** check `DATABASE_URL` (the app user's credentials) and network access. "Access denied"
  after a credential rotation: re-run `scripts/provision-db-users.js` with the new password.
- **redis:** the API keeps serving (rate limits fall back to memory), but queues and sockets stall.
  Check `REDIS_URL` (`rediss://` for TLS) and the password.
- **storage:** check `S3_*`, bucket names and that the credentials can `HeadBucket`.
- **Startup exits immediately** with "Invalid environment configuration": the message lists each variable
  and what is wrong ([environment.md](environment.md)).

## Errors (5xx)
1. Find the `requestId` and its `unhandled error` log line (the stack is in the log, never in the response).
2. Prisma `P2034` / deadlocks are retried automatically by `withTransaction`. A burst of them means hot
   contention: check concurrent bulk operations.
3. `503` "request timed out": the request ran past `REQUEST_TIMEOUT_MS`. See slow requests.

## Slow requests
- `OrbitApiLatencyHigh`: find the slow `route` in `http_request_duration_seconds`.
- Reproduce with `scripts/perf/query-profile.js <user> <path>`: it prints the query count and every
  statement over 50 ms. Hundreds of queries means a per-person loop (see `memberZones` for the pattern);
  one slow statement means `EXPLAIN` and an index ([performance.md](performance.md)).
- Reports show "figures may be incomplete": daily stats for part of the range were not computed yet; a
  background backfill is queued (needs the worker). It completes on the next run.

## Failed jobs
- `OrbitJobsFailing`: the worker log line `job failed` has the queue, job id, attempt and error.
  Jobs retry with backoff; `final="true"` means retries are exhausted.
- Rollups stale: check `stats-dirty` runs every 5 minutes and that the worker can reach the database
  (`metrics_source_up`).
- Leave balances unchanged on the 1st: `leave-accruals` runs daily at 01:15 UTC and is idempotent.
  Re-running it is safe.

## Outbox lag
`OrbitOutboxLag`: notifications, emails and webhooks wait in `outbox_events`. Is the worker running?
Is Redis reachable? Rows with `attempts > 0` and a `last_error` show why publishing failed.

## Webhooks
- A webhook switched itself off after 20 consecutive failed deliveries (shown in Settings → Integrations
  with the reason). Fix the receiver, turn the webhook back on, and replay the deliveries you need.
- "Refused to connect to a private address": the URL resolves to a private, loopback or metadata
  address. That is blocked by design (SSRF guard).
- Receivers rejecting retries as replays: they must record the delivery id only *after* handling the
  event ([integrations.md](integrations.md)).

## Sign-in and sessions
- Everyone signed out after a deploy: `SESSION_SECRET` changed.
- Cookies not sent in production: `APP_ORIGIN` must be the exact `https://` origin users open (it decides
  `Secure` and the `__Host-` prefix).
- 429 on login: per-IP and per-account limits (and 5 r/s per IP at Nginx). Behind a load balancer, set
  `TRUST_PROXY` to the number of proxies, or every user shares the proxy's IP.
- API key gets 401: the key expired or was revoked, or its creator lost the permission. A key only has
  the permissions its creator still holds.

## Browser shows a blank page or broken uploads
Open the browser console. "Refused to … Content Security Policy" means:
- uploads or images from object storage are blocked: add the bucket origin to `CSP_STORAGE_ORIGINS`;
- realtime blocked in development: set `NEXT_PUBLIC_REALTIME_URL` to the API origin.

The CSP nonce requires dynamic rendering; a page that stays static would lose its scripts (the root
layout forces dynamic rendering).

## Database migrations
- "Migration failed to apply … A migration failed to apply. New migrations cannot be applied": a release
  migration stopped halfway. Inspect what it changed, fix forward, then mark it with
  `prisma migrate resolve --applied <name>` or `--rolled-back <name>`. Never edit an applied migration.
- "You do not have the SUPER privilege and binary logging is enabled" while creating triggers: set
  `log_bin_trust_function_creators=1` on the server.
- New triggers: write bodies as `BEGIN … END` (see [backup-restore.md](backup-restore.md) for why).

## Backups and restores
- "Access denied" from `mysqldump` although the URL works elsewhere: a `~/.my.cnf` on that machine
  overrides credentials. The scripts pass `--defaults-file`, so this only bites manual commands.
- "Can't connect to local MySQL server through socket": `localhost` makes MySQL clients use a Unix
  socket; the scripts force TCP. For manual commands use `-h 127.0.0.1`.
- Restore fails near `' */'` on a `CREATE TRIGGER` line: the dump predates migration
  `20261022130000`. `restore-verify.js` repairs these lines; for a manual restore pipe through the same fix.
- "checksum mismatch": the dump file is incomplete or was altered. Use the previous backup and
  investigate the storage.

## Partition maintenance
- "no archive bucket configured, kept": set `S3_BUCKET_ARCHIVE`; audit and access-log months are never
  dropped without a verified archive.
- "Expected the last partition to be pmax": a table's partitions were changed by hand. Restore the layout
  from migration `20261022090000` (the integration test shows how).

## Desktop agent
- macOS: no screenshots → System Settings → Privacy & Security → Screen Recording must allow Orbit
  Desktop. The agent shows its state in the tray; it never captures while you are clocked out, on a
  break, or without your acknowledgement of the current policy.
- "Device revoked": an administrator or the employee disconnected it; pair again with a new code.
