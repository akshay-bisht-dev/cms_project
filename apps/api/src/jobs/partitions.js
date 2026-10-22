import { gzipSync } from 'node:zlib';

/**
 * Partition lifecycle for the append-only event tables (migration 20261022090000). Monthly RANGE
 * COLUMNS partitions named pYYYYMM (rows before the first day of the next month), plus p_before for
 * older rows and pmax for newer ones. Runs as its own database user (DATABASE_MAINTENANCE_URL): the
 * application user never holds ALTER or DROP, so it cannot drop audit history this way.
 */
export const PARTITIONED_TABLES = Object.freeze({
  activity_events: { column: 'occurred_at', retentionEnv: 'RETENTION_ACTIVITY_MONTHS', defaultMonths: 13, archive: false },
  audit_logs: { column: 'at', retentionEnv: 'RETENTION_AUDIT_MONTHS', defaultMonths: 24, archive: true },
  screenshot_access_logs: { column: 'at', retentionEnv: 'RETENTION_ACCESS_LOG_MONTHS', defaultMonths: 24, archive: true },
  login_attempts: { column: 'at', retentionEnv: 'RETENTION_LOGIN_ATTEMPT_MONTHS', defaultMonths: 3, archive: false },
});

const monthStart = (date, offset = 0) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1));
const isoDay = (d) => d.toISOString().slice(0, 10);
const partitionName = (d) => `p${d.toISOString().slice(0, 7).replace('-', '')}`;

/** information_schema description ("'2026-08-01 00:00:00'" or "MAXVALUE") → Date or null. */
export function parseBound(description) {
  if (!description || description === 'MAXVALUE') return null;
  const day = /(\d{4}-\d{2}-\d{2})/.exec(description)?.[1];
  if (!day) throw new Error(`Unrecognized partition bound: ${description}`);
  return new Date(`${day}T00:00:00Z`);
}

/**
 * Decides what to do for one table. `partitions` are { name, bound: Date|null } in order.
 * - add: months from the current one up to `aheadMonths` ahead that have no partition yet
 *   (created by splitting pmax, so rows already in pmax move to the right month);
 * - drop: partitions whose every row is older than the retention cutoff (start of the month
 *   `retentionMonths` before the current one). pmax is never dropped.
 */
export function planPartitions(partitions, { now, aheadMonths = 3, retentionMonths }) {
  if (!partitions.length) return { partitioned: false, add: [], drop: [] };
  const last = partitions.at(-1);
  if (last.name !== 'pmax' || last.bound !== null) throw new Error('Expected the last partition to be pmax (MAXVALUE)');
  const bounded = partitions.filter((p) => p.bound);
  const highest = bounded.at(-1)?.bound ?? monthStart(now);
  const add = [];
  for (let i = 0; i <= aheadMonths; i += 1) {
    const month = monthStart(now, i);
    const upper = monthStart(month, 1);
    if (upper > highest) add.push({ name: partitionName(month), lessThan: isoDay(upper) });
  }
  const cutoff = monthStart(now, -retentionMonths);
  // Keep at least one bounded partition so the table never loses its lowest range.
  const drop = bounded.filter((p) => p.bound <= cutoff).map((p) => p.name).slice(0, Math.max(0, bounded.length - 1));
  return { partitioned: true, add, drop, cutoff: isoDay(cutoff) };
}

export function retentionMonthsFor(table, env = process.env) {
  const spec = PARTITIONED_TABLES[table];
  const raw = env[spec.retentionEnv];
  const months = raw === undefined || raw === '' ? spec.defaultMonths : Number(raw);
  if (!Number.isInteger(months) || months < 1 || months > 120) throw new Error(`${spec.retentionEnv} must be a whole number of months (1–120)`);
  if (spec.archive && months < 12) throw new Error(`${spec.retentionEnv} may not be below 12 months`);
  return months;
}

async function listPartitions(db, table) {
  const rows = await db.$queryRaw`
    SELECT partition_name AS name, partition_description AS description
    FROM information_schema.partitions
    WHERE table_schema = DATABASE() AND table_name = ${table} AND partition_name IS NOT NULL
    ORDER BY partition_ordinal_position`;
  return rows.map((r) => ({ name: r.name, bound: parseBound(r.description) }));
}

/** Streams a partition to gzip JSONL in the archive bucket and checks the object before any drop. */
async function archivePartition({ db, storage, bucket, table, column, partition, now }) {
  const [{ total }] = await db.$queryRawUnsafe(`SELECT COUNT(*) AS total FROM \`${table}\` PARTITION (\`${partition}\`)`);
  const expected = Number(total);
  const lines = [];
  let cursor = null;
  for (;;) {
    const page = cursor
      ? await db.$queryRawUnsafe(`SELECT * FROM \`${table}\` PARTITION (\`${partition}\`) WHERE (\`${column}\`, id) > (?, ?) ORDER BY \`${column}\`, id LIMIT 5000`, cursor[0], cursor[1])
      : await db.$queryRawUnsafe(`SELECT * FROM \`${table}\` PARTITION (\`${partition}\`) ORDER BY \`${column}\`, id LIMIT 5000`);
    for (const row of page) lines.push(JSON.stringify(row, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
    if (page.length < 5000) break;
    const last = page.at(-1);
    cursor = [last[column], last.id];
  }
  if (lines.length !== expected) throw new Error(`${table}.${partition}: read ${lines.length} rows, expected ${expected}`);
  const body = gzipSync(lines.length ? `${lines.join('\n')}\n` : '');
  const key = `archive/${table}/${partition}-${now.toISOString().replace(/[:.]/g, '')}.jsonl.gz`;
  await storage.putObject({ bucket, key, body, contentType: 'application/gzip' });
  const stored = await storage.head({ bucket, key });
  if (!stored || Number(stored.contentLength) !== body.length) throw new Error(`${table}.${partition}: archive object ${key} could not be verified`);
  return { key, rows: expected, bytes: body.length };
}

/**
 * Adds partitions ahead and drops expired ones for every partitioned table. Archived tables are
 * dropped only after their partition is exported and verified; without an archive bucket they are
 * kept (and reported). `dryRun` returns the plan without changing anything.
 */
export async function runPartitionMaintenance({ db, storage, archiveBucket, now = new Date(), aheadMonths = 3, env = process.env, dryRun = false, logger }) {
  const results = [];
  await db.$executeRawUnsafe('SET SESSION lock_wait_timeout = 30');
  for (const [table, spec] of Object.entries(PARTITIONED_TABLES)) {
    const plan = planPartitions(await listPartitions(db, table), { now, aheadMonths, retentionMonths: retentionMonthsFor(table, env) });
    const result = { table, ...plan, added: [], dropped: [], archived: [], skipped: [] };
    results.push(result);
    if (!plan.partitioned) {
      result.skipped.push('table is not partitioned');
      continue;
    }
    if (dryRun) continue;
    if (plan.add.length) {
      const parts = plan.add.map((p) => `PARTITION \`${p.name}\` VALUES LESS THAN ('${p.lessThan}')`).join(', ');
      await db.$executeRawUnsafe(`ALTER TABLE \`${table}\` REORGANIZE PARTITION pmax INTO (${parts}, PARTITION pmax VALUES LESS THAN (MAXVALUE))`);
      result.added = plan.add.map((p) => p.name);
    }
    for (const partition of plan.drop) {
      if (spec.archive) {
        if (!archiveBucket || !storage) {
          result.skipped.push(`${partition}: no archive bucket configured (S3_BUCKET_ARCHIVE), kept`);
          continue;
        }
        result.archived.push(await archivePartition({ db, storage, bucket: archiveBucket, table, column: spec.column, partition, now }));
      }
      await db.$executeRawUnsafe(`ALTER TABLE \`${table}\` DROP PARTITION \`${partition}\``);
      result.dropped.push(partition);
    }
    logger?.info({ table, added: result.added, dropped: result.dropped, skipped: result.skipped }, 'partition maintenance');
  }
  return results;
}
