import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildTestApp } from '../helpers/test-app.js';
import { resetDatabase } from '../helpers/db.js';
import { createOrg } from '../helpers/factories.js';
import { backup } from '../../scripts/backup/backup.js';
import { compareManifests, normalizeDumpLine, restoreVerify } from '../../scripts/backup/restore-verify.js';

const { prisma } = buildTestApp();
const db = prisma.unscoped;
afterAll(() => prisma.$disconnect());

/** mysql/mysqldump from MYSQL_BIN/MYSQLDUMP_BIN or PATH, or null. */
function binary(envName, name) {
  if (process.env[envName]) return process.env[envName];
  try {
    return execFileSync('which', [name], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

describe('backups', () => {
  it('stores no trigger body with a trailing delimiter (it breaks mysqldump restores)', async () => {
    const triggers = await db.$queryRaw`SELECT trigger_name AS name, action_statement AS body FROM information_schema.triggers WHERE trigger_schema = DATABASE()`;
    expect(triggers.length).toBeGreaterThanOrEqual(15);
    expect(triggers.filter((t) => t.body.trim().endsWith(';')).map((t) => t.name)).toEqual([]);
  });

  it('repairs old-style trigger lines and strips definers while restoring, leaving data alone', () => {
    const old = "/*!50003 CREATE*/ /*!50017 DEFINER=`app`@`%`*/ /*!50003 TRIGGER `t_u` BEFORE UPDATE ON `t` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'x'; */;;";
    expect(normalizeDumpLine(old)).toBe("/*!50003 CREATE*/ /*!50017 */ /*!50003 TRIGGER `t_u` BEFORE UPDATE ON `t` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'x' */;;");
    const current = "/*!50003 CREATE*/ /*!50003 TRIGGER `t_u` BEFORE UPDATE ON `t` FOR EACH ROW BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'x'; END */;;";
    expect(normalizeDumpLine(current)).toBe(current);
    expect(normalizeDumpLine("INSERT INTO `t` VALUES ('a; */;;');")).toBe("INSERT INTO `t` VALUES ('a; */;;');");
  });

  it('compares a restore with its manifest: exact by default, tolerant of live-backup drift on request', () => {
    const manifest = { tables: ['a', 'b'], counts: { a: 1000, b: 5 }, migrations: [{ name: 'm1', checksum: 'x' }], triggers: ['a_no_update'] };
    expect(compareManifests(manifest, { ...manifest }).ok).toBe(true);
    const drifted = { ...manifest, counts: { a: 1004, b: 5 } };
    expect(compareManifests(manifest, drifted).ok).toBe(false);
    expect(compareManifests(manifest, drifted, { maxDriftPct: 1 }).ok).toBe(true);
    expect(compareManifests(manifest, { ...manifest, counts: { a: 1000, b: 0 } }, { maxDriftPct: 100 }).problems).toEqual(['b: restored empty, expected 5 rows']);
    expect(compareManifests(manifest, { ...manifest, tables: ['a'], counts: { a: 1000 }, triggers: [] }).problems).toEqual(['missing tables: b', 'missing triggers: a_no_update', 'b: restored empty, expected 5 rows']);
    expect(compareManifests(manifest, { ...manifest, migrations: [{ name: 'm1', checksum: 'y' }] }).problems).toEqual(['applied migrations differ']);
  });

  const mysqldump = binary('MYSQLDUMP_BIN', 'mysqldump');
  const mysql = binary('MYSQL_BIN', 'mysql');
  const adminUrl = process.env.RESTORE_ADMIN_URL ?? process.env.SHADOW_DATABASE_URL;
  const canRoundTrip = Boolean(mysqldump && mysql && adminUrl);
  it.skipIf(!canRoundTrip)('backs up the test database and restores it into a verified copy', async () => {
    await resetDatabase(db);
    await createOrg(prisma);
    const dir = mkdtempSync(join(tmpdir(), 'orbit-backup-test-'));
    try {
      const { manifestFile, record } = await backup({ url: process.env.DATABASE_URL, dir, mysqldump });
      expect(record.counts.organizations).toBe(1);
      expect(record.triggers.length).toBeGreaterThanOrEqual(15);
      const admin = new URL(adminUrl);
      admin.pathname = '/mysql';
      const result = await restoreVerify({ manifestPath: manifestFile, adminUrl: admin.toString(), mysql });
      expect(result.problems).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.steps.find((s) => s.name === 'invariants')).toMatchObject({ auditLogAppendOnly: true, orphanMembers: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
