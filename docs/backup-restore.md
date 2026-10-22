# Backup, restore and disaster recovery

## What is backed up, and how
| Data | Mechanism | Frequency | Where |
|---|---|---|---|
| MySQL (all business data) | `scripts/backup/backup.js`: `mysqldump --single-transaction` (consistent, no locks), gzip, optional `age` encryption, a manifest with sha256, per-table row counts, migrations and triggers | Daily 01:30 UTC (CronJob `mysql-backup` / host timer) | Off-site bucket (`BACKUP_S3_BUCKET`), separate account, object lock |
| MySQL, between backups | Managed: the provider's point-in-time recovery (enable it). Self-hosted: binary logs kept 7 days on the data volume | Continuous | Managed service / data volume |
| Object storage (files, captures) | Bucket versioning + cross-region replication for `files`. Captures stay in the primary region (privacy; accepted risk) | Continuous | Provider |
| Redis | AOF. Rebuildable: queued work is re-published from the outbox, caches refill | — | — |
| Configuration and secrets | Your secret manager; manifests in git | — | — |

**Encryption:** set `BACKUP_AGE_RECIPIENT` (an `age` public key) so dumps are encrypted before leaving
the host. Only the restore runner holds the private key (`BACKUP_AGE_IDENTITY`). Local dump files are
created owner-only (0600).

**Least privilege:** the backup user can only read: `SELECT, SHOW VIEW, TRIGGER, LOCK TABLES, EVENT` and
`PROCESS` (`scripts/provision-db-users.js`). Credentials reach `mysqldump` through a private temporary
option file, never the command line, so they never appear in the process list.

## Restore verification (scheduled)
`scripts/backup/restore-verify.js` restores the newest backup into a throwaway database on an
**isolated restore server** and checks:
1. the dump's sha256 against the manifest, and the `-- Dump completed` trailer (truncated dumps fail);
2. every table and trigger present, and the applied migrations identical (names and checksums);
3. row counts per table (exact; `RESTORE_MAX_DRIFT_PCT` tolerates the gap between manifest and dump
   snapshot on a busy database);
4. invariants: no orphaned members or time entries, no `PAID` invoice not covered by payments, and the
   audit log's append-only trigger working.

It writes a JSON report, drops the scratch database and exits 1 on any problem: the CronJob
`mysql-restore-verify` runs weekly and alerts on failure.

### Drill, 2026-10-22 (evidence: [`evidence/phase-11/restore-drill.json`](evidence/phase-11/restore-drill.json))
| | |
|---|---|
| Source | `orbit_perf_test`: 108 tables, 1,394,748 rows, 15 triggers, 14 migrations |
| Backup | 8.6 s, 59.5 MB gzip, as the least-privilege backup user |
| Restore + verification | **100.5 s**: checksum ok, all tables/triggers/migrations present, **zero row drift**, invariants ok |

**The drill found a real defect.** Triggers created by Prisma migrations were stored with a trailing
`;` in their body (MySQL keeps the delimiter when a migration runs as one multi-statement batch).
`mysqldump` wraps trigger bodies in `/*!50003 … */`, so on restore that `;` ended the statement early,
and **every logical backup failed to restore**. Fixed in two places:
- migration `20261022130000_restorable_triggers` recreates all 15 triggers with `BEGIN … END` bodies,
  creating each new trigger before dropping the old one so the tables are never unprotected;
- the restore stream repairs the old form, so dumps taken before the fix restore too (verified on the
  pre-fix dump, `restore-drill-prefix-dump.json`).

`tests/integration/backup.test.js` fails if any trigger body ends in `;`, and runs a real backup →
restore → verify round trip wherever `mysqldump` is available (CI included).

## Recovery objectives
| | With managed MySQL PITR | With these scripts only |
|---|---|---|
| **RPO** (data loss) | ≤ 5 min (provider log shipping) | ≤ 24 h (daily backup). Binary logs on the data volume narrow this only if the volume survives |
| **RTO** (back in service) | ≤ 1 h | ≤ 4 h. A 1.4 M-row database restores in under 2 minutes; restore time grows roughly linearly with size |

Shipping self-hosted binary logs off the host is **not built**; use managed MySQL for the 15-minute RPO
target in docs/deployment.md.

## Runbooks
### A. Restore the database after loss or corruption
1. Declare an incident; put the app in maintenance (scale `api` and `worker` to 0, or stop them).
2. Provision an empty MySQL 8.4 (same major version) with `log_bin_trust_function_creators=1`.
3. Fetch and verify the newest good backup *without* dropping it:
   `BACKUP_S3_BUCKET=… RESTORE_ADMIN_URL=mysql://admin:…@new-db:3306/mysql RESTORE_KEEP=true node scripts/backup/restore-verify.js`
   The report names the scratch database (`orbit_restore_verify_…`) it left in place.
4. Rename it to `orbit`, or dump it and load it as `orbit`. Run `scripts/provision-db-users.js` against
   the new server, then `prisma migrate status` with the migrate user: it must say "up to date".
5. Point `DATABASE_URL` at the new server, start `api` and `worker`, check `/api/v1/health/ready`, then
   spot-check a recent invoice, timesheet and the audit log.
6. With managed PITR, prefer the provider's point-in-time restore to just before the incident, then
   follow steps 4–5.

### B. Recover data deleted by mistake (database otherwise healthy)
Restore the relevant backup to a scratch database with `RESTORE_KEEP=true`, copy the affected rows back
with a reviewed script, and record what was restored in the audit log (an `org.data` action by an owner).
Append-only tables (audit, ledgers, approvals, consents) are never edited, only appended to.

### C. Redis lost
Start a new Redis. API and worker reconnect. Unpublished outbox events are re-published by the relay;
jobs that were running are retried. Sessions are not lost (they live in MySQL); rate-limit counters
restart (the in-memory fallback covers the gap).

### D. Object storage lost or objects deleted
Restore from bucket versions or the replica bucket. Screenshots outside the primary region are not
replicated by design: they are reported as missing and the gaps are explained in the timeline.

### E. Encryption key questions
The `age` private key is in the secret manager *and* in a sealed offline copy held by two people.
Losing every copy makes encrypted backups unrecoverable: rehearse retrieval during the quarterly drill.

## Drill schedule
Weekly automated restore verification. Quarterly, a person runs runbook A end to end on a staging copy,
records the times in this file, and checks the key-retrieval procedure.
