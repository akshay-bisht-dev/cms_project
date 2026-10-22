// Partition maintenance for the event tables: adds months ahead, archives then drops expired months.
//   node scripts/partition-maintenance.js            # apply
//   node scripts/partition-maintenance.js --dry-run  # print the plan only
// Connects with DATABASE_MAINTENANCE_URL (a user with ALTER and DROP on the four partitioned tables
// only; see infrastructure/mysql/production-grants.sql). Audit and screenshot-access partitions are
// dropped only after export to S3_BUCKET_ARCHIVE. Exit code 1 on any failure, so the scheduler alerts.
import { PrismaClient } from '@prisma/client';
import pino from 'pino';
import { createStorage } from '../src/services/storage.js';
import { runPartitionMaintenance } from '../src/jobs/partitions.js';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const url = process.env.DATABASE_MAINTENANCE_URL;
if (!url) {
  logger.error('DATABASE_MAINTENANCE_URL is not set');
  process.exit(1);
}
const dryRun = process.argv.includes('--dry-run');
const archiveBucket = process.env.S3_BUCKET_ARCHIVE || null;
const storage = archiveBucket ? createStorage({ ...process.env, S3_FORCE_PATH_STYLE: process.env.S3_FORCE_PATH_STYLE === 'true', S3_BUCKET_CAPTURES: archiveBucket, S3_BUCKET_FILES: archiveBucket }) : null;
const db = new PrismaClient({ datasourceUrl: url });

try {
  const results = await runPartitionMaintenance({ db, storage, archiveBucket, dryRun, logger, aheadMonths: Number(process.env.PARTITION_AHEAD_MONTHS ?? 3) });
  process.stdout.write(`${JSON.stringify({ dryRun, results }, null, 2)}\n`);
} catch (err) {
  logger.error({ err }, 'partition maintenance failed');
  process.exitCode = 1;
} finally {
  await db.$disconnect();
  storage?.destroy?.();
}
