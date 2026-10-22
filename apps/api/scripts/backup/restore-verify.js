// Restores a backup into a throwaway database and proves it is usable (docs/backup-restore.md).
//   RESTORE_ADMIN_URL=mysql://admin:…@restore-db:3306/mysql node scripts/backup/restore-verify.js backups/orbit-….manifest.json
// Without an argument, the newest manifest in BACKUP_DIR is used. Checks: checksum, dump completed,
// every table and trigger present, migrations identical, row counts (exact, or within
// RESTORE_MAX_DRIFT_PCT for a backup of a live database), and data invariants. Writes a JSON log next
// to the manifest, drops the scratch database (RESTORE_KEEP=true keeps it) and exits 1 on any failure.
// Encrypted dumps (.age) are decrypted with the identity file in BACKUP_AGE_IDENTITY.
import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { spawn } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { connectionFromUrl, readManifest, run, withClientConfig } from './backup.js';

// Line fixes applied while restoring: DEFINER clauses are removed (triggers restore under the
// restoring account), and a trigger body stored with a trailing delimiter (as triggers created before
// migration 20261022130000 were) has it removed: otherwise that ';' ends the statement inside
// mysqldump's versioned-comment wrapper around trigger bodies and aborts the restore.
export function normalizeDumpLine(line) {
  let out = line.replace(/DEFINER=`[^`]*`@`[^`]*`\s*/g, '');
  if (out.startsWith('/*!50003 CREATE*/') && out.includes(' TRIGGER ')) out = out.replace(/;\s*\*\/;;$/, ' */;;');
  return out;
}

export function normalizeDump() {
  let carry = '';
  const fix = (text) => text.split('\n').map(normalizeDumpLine).join('\n');
  return new Transform({
    transform(chunk, _enc, done) {
      const text = carry + chunk.toString('utf8');
      const cut = text.lastIndexOf('\n') + 1;
      carry = text.slice(cut);
      done(null, fix(text.slice(0, cut)));
    },
    flush(done) {
      done(null, fix(carry));
    },
  });
}

/** Compares a restored database with the backup's manifest. Pure, so it is unit-tested. */
export function compareManifests(expected, actual, { maxDriftPct = 0 } = {}) {
  const problems = [];
  const missing = expected.tables.filter((t) => !actual.tables.includes(t));
  if (missing.length) problems.push(`missing tables: ${missing.join(', ')}`);
  const missingTriggers = expected.triggers.filter((t) => !actual.triggers.includes(t));
  if (missingTriggers.length) problems.push(`missing triggers: ${missingTriggers.join(', ')}`);
  const sig = (list) => list.map((m) => `${m.name}:${m.checksum}`).join('|');
  if (sig(expected.migrations) !== sig(actual.migrations)) problems.push('applied migrations differ');
  const drift = [];
  for (const t of expected.tables) {
    const want = expected.counts[t];
    const got = actual.counts[t] ?? 0;
    if (want === got) continue;
    const pct = want ? (Math.abs(got - want) / want) * 100 : 100;
    drift.push({ table: t, expected: want, restored: got, pct: Number(pct.toFixed(3)) });
    if (want > 0 && got === 0) problems.push(`${t}: restored empty, expected ${want} rows`);
    else if (pct > maxDriftPct) problems.push(`${t}: ${got} rows restored, expected ${want} (${pct.toFixed(2)}% > ${maxDriftPct}%)`);
  }
  return { ok: problems.length === 0, problems, drift };
}

/** Application-level checks that a corrupt or partial restore would fail. */
async function invariants(db) {
  const checks = {};
  const one = async (sql) => Number((await db.$queryRawUnsafe(sql))[0].n);
  checks.orphanMembers = await one('SELECT COUNT(*) AS n FROM organization_members m LEFT JOIN users u ON u.id = m.user_id WHERE u.id IS NULL');
  checks.orphanTimeEntries = await one('SELECT COUNT(*) AS n FROM time_entries e LEFT JOIN organization_members m ON m.organization_id = e.organization_id AND m.user_id = e.user_id WHERE m.id IS NULL');
  checks.paidWithoutPayments = await one("SELECT COUNT(*) AS n FROM invoices WHERE status = 'PAID' AND (amount_paid < total OR amount_paid <= 0)");
  // The append-only trigger must have come back with the data.
  let auditGuarded;
  try {
    await db.$executeRawUnsafe('UPDATE audit_logs SET action = action LIMIT 1');
    auditGuarded = (await one('SELECT COUNT(*) AS n FROM audit_logs')) === 0;
  } catch {
    auditGuarded = true;
  }
  checks.auditLogAppendOnly = auditGuarded;
  const problems = [];
  if (checks.orphanMembers) problems.push(`${checks.orphanMembers} members without a user`);
  if (checks.orphanTimeEntries) problems.push(`${checks.orphanTimeEntries} time entries without a member`);
  if (checks.paidWithoutPayments) problems.push(`${checks.paidWithoutPayments} PAID invoices not covered by payments`);
  if (!checks.auditLogAppendOnly) problems.push('audit_logs accepted an UPDATE: triggers did not restore');
  return { checks, problems };
}

export async function restoreVerify({ manifestPath, adminUrl, mysql = 'mysql', age = 'age', ageIdentity, maxDriftPct = 0, keep = false, now = new Date(), log = () => {} }) {
  const startedAt = Date.now();
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const file = join(dirname(manifestPath), manifest.file);
  const result = { manifest: manifestPath, file: manifest.file, startedAt: now.toISOString(), steps: [], problems: [] };
  const step = (name, detail) => {
    result.steps.push({ name, ...detail, atMs: Date.now() - startedAt });
    log(`${name}${detail ? ` ${JSON.stringify(detail)}` : ''}`);
  };

  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  const digest = hash.digest('hex');
  if (digest !== manifest.sha256) throw new Error(`checksum mismatch: ${digest} ≠ ${manifest.sha256}`);
  step('checksum ok', { sha256: digest.slice(0, 16) });

  const admin = connectionFromUrl(adminUrl);
  const scratch = `orbit_restore_verify_${now.toISOString().replace(/\D/g, '').slice(0, 14)}`;
  const adminDb = new PrismaClient({ datasourceUrl: adminUrl });
  try {
    await adminDb.$executeRawUnsafe(`CREATE DATABASE \`${scratch}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    step('scratch database created', { database: scratch });
    let sawCompletion = false;
    const completion = new Transform({
      transform(chunk, _enc, done) {
        if (chunk.includes('-- Dump completed')) sawCompletion = true;
        done(null, chunk);
      },
    });
    const source = () => {
      if (!manifest.encrypted) return createReadStream(file);
      if (!ageIdentity) throw new Error('backup is encrypted: set BACKUP_AGE_IDENTITY');
      return spawn(age, ['--decrypt', '--identity', ageIdentity, file], { stdio: ['ignore', 'pipe', 'inherit'] }).stdout;
    };
    await withClientConfig(admin, (optionFile) =>
      run(mysql, [`--defaults-file=${optionFile}`, '--default-character-set=utf8mb4', scratch], {
        env: process.env,
        stdin: (input) => pipeline(source(), createGunzip(), completion, normalizeDump(), input),
      }),
    );
    if (!sawCompletion) throw new Error('dump is truncated: no "Dump completed" marker');
    step('restored', { seconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)) });

    const url = new URL(adminUrl);
    url.pathname = `/${scratch}`;
    const restored = new PrismaClient({ datasourceUrl: url.toString() });
    try {
      const actual = await readManifest(restored);
      const compared = compareManifests(manifest, actual, { maxDriftPct });
      step('compared with manifest', { tables: actual.tables.length, triggers: actual.triggers.length, migrations: actual.migrations.length, rows: Object.values(actual.counts).reduce((a, b) => a + b, 0), drift: compared.drift });
      result.problems.push(...compared.problems);
      const inv = await invariants(restored);
      step('invariants', inv.checks);
      result.problems.push(...inv.problems);
    } finally {
      await restored.$disconnect();
    }
  } finally {
    if (!keep) {
      await adminDb.$executeRawUnsafe(`DROP DATABASE IF EXISTS \`${scratch}\``);
      step('scratch database dropped');
    }
    await adminDb.$disconnect();
  }
  result.ok = result.problems.length === 0;
  result.seconds = Number(((Date.now() - startedAt) / 1000).toFixed(1));
  return result;
}

/**
 * Downloads the newest backup (manifest + dump) from BACKUP_S3_BUCKET/BACKUP_S3_PREFIX into `dir`:
 * a scheduled restore check runs on a different machine or pod than the backup. The checksum in the
 * manifest is then verified as for a local file.
 */
export async function fetchLatestFromS3({ dir, bucket, prefix = 'mysql/' }) {
  const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
  const { createStorage } = await import('../../src/services/storage.js');
  const storage = createStorage({ ...process.env, S3_FORCE_PATH_STYLE: process.env.S3_FORCE_PATH_STYLE === 'true', S3_BUCKET_CAPTURES: bucket, S3_BUCKET_FILES: bucket });
  try {
    const manifests = [];
    let token;
    do {
      const page = await storage.client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
      manifests.push(...(page.Contents ?? []).map((o) => o.Key).filter((k) => k.endsWith('.manifest.json')));
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    const latest = manifests.sort().at(-1);
    if (!latest) throw new Error(`no backups under s3://${bucket}/${prefix}`);
    mkdirSync(dir, { recursive: true });
    const manifestPath = join(dir, latest.split('/').at(-1));
    const manifestBody = await storage.getObject({ bucket, key: latest });
    writeFileSync(manifestPath, manifestBody, { mode: 0o600 });
    const { file } = JSON.parse(manifestBody.toString('utf8'));
    writeFileSync(join(dir, file), await storage.getObject({ bucket, key: `${prefix}${file}` }), { mode: 0o600 });
    return manifestPath;
  } finally {
    storage.destroy();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const adminUrl = process.env.RESTORE_ADMIN_URL;
  const dir = resolve(process.env.BACKUP_DIR ?? 'backups');
  const local = () => {
    try {
      return readdirSync(dir).filter((f) => f.endsWith('.manifest.json')).sort().at(-1);
    } catch {
      return undefined;
    }
  };
  let manifestPath = process.argv[2] ? resolve(process.argv[2]) : local() ? join(dir, local()) : null;
  const log = (msg) => process.stdout.write(`${new Date().toISOString()} ${msg}\n`);
  let result;
  try {
    if (!adminUrl) throw new Error('RESTORE_ADMIN_URL is not set');
    if (!manifestPath && process.env.BACKUP_S3_BUCKET) manifestPath = await fetchLatestFromS3({ dir, bucket: process.env.BACKUP_S3_BUCKET, prefix: process.env.BACKUP_S3_PREFIX ?? 'mysql/' });
    if (!manifestPath) throw new Error(`no backup found in ${dir} (set BACKUP_S3_BUCKET to fetch the latest)`);
    result = await restoreVerify({ manifestPath, adminUrl, mysql: process.env.MYSQL_BIN ?? 'mysql', ageIdentity: process.env.BACKUP_AGE_IDENTITY, maxDriftPct: Number(process.env.RESTORE_MAX_DRIFT_PCT ?? 0), keep: process.env.RESTORE_KEEP === 'true', log });
  } catch (err) {
    result = { manifest: manifestPath, ok: false, problems: [err.message] };
  }
  const logFile = manifestPath ? manifestPath.replace('.manifest.json', '.restore-verify.json') : join(dir, 'restore-verify-failed.json');
  try {
    writeFileSync(logFile, `${JSON.stringify(result, null, 2)}\n`);
  } catch {
    // The manifest directory may be read-only; the summary below still reaches the scheduler's log.
  }
  log(result.ok ? `RESTORE VERIFIED in ${result.seconds}s` : `RESTORE FAILED: ${result.problems.join('; ')}`);
  process.exitCode = result.ok ? 0 : 1;
}
