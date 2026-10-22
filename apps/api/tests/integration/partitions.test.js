import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, fakeStorage } from '../helpers/test-app.js';
import { resetDatabase } from '../helpers/db.js';
import { runPartitionMaintenance } from '../../src/jobs/partitions.js';

const { prisma } = buildTestApp();
const db = prisma.unscoped;
const migration = readFileSync(new URL('../../prisma/migrations/20261022090000_partition_event_tables/migration.sql', import.meta.url), 'utf8');

/** Puts the four tables back to the migration's layout (the test changes it). */
async function restoreLayout() {
  const sql = migration.replace(/^\s*--.*$/gm, '');
  for (const statement of sql.split(';').map((s) => s.trim()).filter(Boolean)) {
    await db.$executeRawUnsafe(statement);
  }
}

const partitions = async (table) =>
  (await db.$queryRaw`SELECT partition_name AS name, table_rows AS n FROM information_schema.partitions WHERE table_schema = DATABASE() AND table_name = ${table} ORDER BY partition_ordinal_position`).map((r) => r.name);

async function audit(at, action) {
  await db.$executeRaw`INSERT INTO audit_logs (id, at, organization_id, actor_type, action, diff) VALUES (${randomUUID()}, ${new Date(at)}, NULL, 'SYSTEM', ${action}, ${JSON.stringify({ n: action })})`;
}

beforeEach(async () => {
  await resetDatabase(db);
  await restoreLayout();
});
afterAll(async () => {
  await restoreLayout();
  await prisma.$disconnect();
});

describe('partition maintenance', () => {
  it('archives expired audit months, verifies the archive, then drops them; keeps months ahead', async () => {
    await audit('2026-06-01T08:00:00Z', 'old.before');
    await audit('2026-07-15T08:00:00Z', 'old.july');
    await audit('2026-07-20T08:00:00Z', 'old.july2');
    await audit('2026-09-03T08:00:00Z', 'kept.september');
    const storage = fakeStorage();
    const now = new Date('2028-09-10T00:00:00Z'); // audit cutoff (24 months): 2026-09-01

    const results = await runPartitionMaintenance({ db, storage, archiveBucket: 'archive', now, env: {} });
    const auditResult = results.find((r) => r.table === 'audit_logs');
    expect(auditResult.dropped).toEqual(['p_before', 'p202607', 'p202608']);
    expect(auditResult.archived.map((a) => a.rows)).toEqual([1, 2, 0]);

    const july = auditResult.archived[1];
    const lines = gunzipSync(storage.objects.get(july.key).body).toString().trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.action)).toEqual(['old.july', 'old.july2']);
    expect((await db.$queryRaw`SELECT action FROM audit_logs ORDER BY at`).map((r) => r.action)).toEqual(['kept.september']);

    const layout = await partitions('audit_logs');
    expect(layout).toContain('p202809');
    expect(layout).toContain('p202812');
    expect(layout.at(-1)).toBe('pmax');
    // New rows still land, and the append-only trigger still applies to ordinary DELETEs.
    await audit('2028-10-02T00:00:00Z', 'new.october');
    await expect(db.$executeRaw`DELETE FROM audit_logs WHERE action = 'new.october'`).rejects.toThrow(/append-only|not allowed|45000/i);
  });

  it('keeps archived tables intact when no archive bucket is configured, but still prunes the others', async () => {
    await audit('2026-06-01T08:00:00Z', 'old.before');
    await db.$executeRaw`INSERT INTO login_attempts (id, at, email_hash, success, reason) VALUES (${randomUUID()}, ${new Date('2026-06-01T00:00:00Z')}, ${'a'.repeat(64)}, 0, 'BAD_PASSWORD')`;
    const results = await runPartitionMaintenance({ db, storage: null, archiveBucket: null, now: new Date('2028-09-10T00:00:00Z'), env: {} });
    const auditResult = results.find((r) => r.table === 'audit_logs');
    expect(auditResult.dropped).toEqual([]);
    expect(auditResult.skipped[0]).toMatch(/no archive bucket/);
    expect(await db.auditLog.count()).toBe(1);
    expect(results.find((r) => r.table === 'login_attempts').dropped).toContain('p_before');
    expect(await db.loginAttempt.count()).toBe(0);
  });

  it('is idempotent and changes nothing in a dry run', async () => {
    const now = new Date('2026-10-22T00:00:00Z');
    const before = await partitions('activity_events');
    const dry = await runPartitionMaintenance({ db, storage: null, archiveBucket: null, now, env: {}, dryRun: true });
    expect(dry.find((r) => r.table === 'activity_events').add.map((a) => a.name)).toEqual([]);
    expect(await partitions('activity_events')).toEqual(before);
    await runPartitionMaintenance({ db, storage: null, archiveBucket: null, now: new Date('2027-02-15T00:00:00Z'), env: {} });
    const once = await partitions('activity_events');
    await runPartitionMaintenance({ db, storage: null, archiveBucket: null, now: new Date('2027-02-15T00:00:00Z'), env: {} });
    expect(await partitions('activity_events')).toEqual(once);
    expect(once).toEqual(expect.arrayContaining(['p202704', 'p202705']));
  });
});
