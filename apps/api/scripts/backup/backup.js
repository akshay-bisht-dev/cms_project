// Logical MySQL backup with a verification manifest (docs/backup-restore.md).
//   BACKUP_DATABASE_URL=mysql://orbit_backup:…@db:3306/orbit node scripts/backup/backup.js
// Optional: BACKUP_DIR (default ./backups), BACKUP_AGE_RECIPIENT (encrypt with `age`),
// BACKUP_S3_BUCKET + BACKUP_S3_PREFIX (upload with the S3_* credentials), BACKUP_KEEP_LOCAL (default 3),
// MYSQLDUMP_BIN. Credentials go in a private temporary option file (0600, deleted afterwards), never on
// the command line, and --defaults-file stops a ~/.my.cnf from overriding them.
// Exit code 1 on any failure, so the scheduler alerts.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { PrismaClient } from '@prisma/client';

export function connectionFromUrl(raw) {
  const url = new URL(raw);
  return { host: url.hostname, port: url.port || '3306', user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: url.pathname.slice(1) };
}

/** Runs fn(optionFile) with the connection's credentials in a private option file for mysql/mysqldump. */
export async function withClientConfig(conn, fn) {
  if (/[\n"\\]/.test(conn.password)) throw new Error('The database password may not contain quotes, backslashes or newlines');
  const dir = mkdtempSync(join(tmpdir(), 'orbit-db-'));
  const file = join(dir, 'client.cnf');
  writeFileSync(file, `[client]\nuser="${conn.user}"\npassword="${conn.password}"\nhost="${conn.host}"\nport=${conn.port}\nprotocol=TCP\n`, { mode: 0o600 });
  try {
    return await fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Table row counts, applied migrations and triggers, as the restore check will compare them. */
export async function readManifest(db) {
  const tables = (await db.$queryRaw`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY table_name`).map((t) => t.name);
  const counts = {};
  for (const t of tables) counts[t] = Number((await db.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM \`${t}\``))[0].n);
  const migrations = (await db.$queryRaw`SELECT migration_name AS name, checksum FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`).map((m) => ({ name: m.name, checksum: m.checksum }));
  const triggers = (await db.$queryRaw`SELECT trigger_name AS name FROM information_schema.triggers WHERE trigger_schema = DATABASE() ORDER BY trigger_name`).map((t) => t.name);
  const [{ v }] = await db.$queryRaw`SELECT VERSION() AS v`;
  return { tables, counts, migrations, triggers, serverVersion: v };
}

/**
 * Runs a binary; resolves when it exits 0 AND, if given, its stdout/stdin stream work has finished
 * (so a dump is fully flushed to disk before it is hashed).
 */
export function run(bin, args, { env, stdin, stdout } = {}) {
  const child = spawn(bin, args, { env, stdio: [stdin ? 'pipe' : 'ignore', stdout ? 'pipe' : 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d;
  });
  const exited = new Promise((resolvePromise, reject) => {
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolvePromise() : reject(new Error(`${bin} exited ${code}: ${stderr.trim().slice(0, 2000)}`))));
  });
  return Promise.all([exited, stdout ? stdout(child.stdout) : null, stdin ? stdin(child.stdin) : null]);
}

async function sha256(file) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

export async function backup({ url, dir, ageRecipient, mysqldump = 'mysqldump', age = 'age', now = new Date(), log = () => {} }) {
  const conn = connectionFromUrl(url);
  mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, '').replace('T', '-').slice(0, 15);
  const base = join(dir, `${conn.database}-${stamp}`);
  const dumpFile = `${base}.sql.gz`;
  const db = new PrismaClient({ datasourceUrl: url });
  let manifest;
  try {
    manifest = await readManifest(db);
  } finally {
    await db.$disconnect();
  }
  log(`manifest: ${manifest.tables.length} tables, ${manifest.migrations.length} migrations`);

  const args = (optionFile) => [
    `--defaults-file=${optionFile}`,
    '--single-transaction', '--quick', '--routines', '--triggers', '--events', '--hex-blob',
    '--set-gtid-purged=OFF', '--no-tablespaces', '--default-character-set=utf8mb4', conn.database,
  ];
  const startedAt = new Date();
  await withClientConfig(conn, (optionFile) => run(mysqldump, args(optionFile), { env: process.env, stdout: (out) => pipeline(out, createGzip({ level: 6 }), createWriteStream(dumpFile, { mode: 0o600 })) }));
  let file = dumpFile;
  if (ageRecipient) {
    file = `${dumpFile}.age`;
    await run(age, ['--encrypt', '--recipient', ageRecipient, '--output', file, dumpFile], { env: process.env });
    rmSync(dumpFile);
  }
  const record = {
    format: 1,
    database: conn.database,
    file: file.split('/').at(-1),
    encrypted: Boolean(ageRecipient),
    sha256: await sha256(file),
    bytes: statSync(file).size,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    ...manifest,
  };
  writeFileSync(`${base}.manifest.json`, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  log(`dump: ${record.file} (${(record.bytes / 1e6).toFixed(1)} MB, sha256 ${record.sha256.slice(0, 12)}…)`);
  return { file, manifestFile: `${base}.manifest.json`, record };
}

async function upload({ file, manifestFile, bucket, prefix }) {
  const { createStorage } = await import('../../src/services/storage.js');
  const storage = createStorage({ ...process.env, S3_FORCE_PATH_STYLE: process.env.S3_FORCE_PATH_STYLE === 'true', S3_BUCKET_CAPTURES: bucket, S3_BUCKET_FILES: bucket });
  const { readFileSync } = await import('node:fs');
  try {
    for (const f of [file, manifestFile]) {
      const key = `${prefix}${f.split('/').at(-1)}`;
      const body = readFileSync(f);
      await storage.putObject({ bucket, key, body, contentType: f.endsWith('.json') ? 'application/json' : 'application/octet-stream' });
      const head = await storage.head({ bucket, key });
      if (!head || Number(head.contentLength) !== body.length) throw new Error(`upload of ${key} could not be verified`);
    }
  } finally {
    storage.destroy();
  }
}

function pruneLocal(dir, database, keep) {
  const dumps = readdirSync(dir).filter((f) => f.startsWith(`${database}-`) && f.endsWith('.manifest.json')).sort();
  for (const manifest of dumps.slice(0, Math.max(0, dumps.length - keep))) {
    const stem = manifest.replace('.manifest.json', '');
    for (const f of readdirSync(dir).filter((x) => x.startsWith(stem))) rmSync(join(dir, f));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.BACKUP_DATABASE_URL;
  if (!url) {
    process.stderr.write('BACKUP_DATABASE_URL is not set\n');
    process.exit(1);
  }
  const dir = resolve(process.env.BACKUP_DIR ?? 'backups');
  const log = (msg) => process.stdout.write(`${new Date().toISOString()} ${msg}\n`);
  try {
    const result = await backup({ url, dir, ageRecipient: process.env.BACKUP_AGE_RECIPIENT, mysqldump: process.env.MYSQLDUMP_BIN ?? 'mysqldump', log });
    if (process.env.BACKUP_S3_BUCKET) {
      await upload({ ...result, bucket: process.env.BACKUP_S3_BUCKET, prefix: process.env.BACKUP_S3_PREFIX ?? 'mysql/' });
      log(`uploaded to s3://${process.env.BACKUP_S3_BUCKET}/${process.env.BACKUP_S3_PREFIX ?? 'mysql/'}`);
    }
    pruneLocal(dir, result.record.database, Number(process.env.BACKUP_KEEP_LOCAL ?? 3));
    log('backup complete');
  } catch (err) {
    process.stderr.write(`backup failed: ${err.message}\n`);
    process.exitCode = 1;
  }
}
