import nodemailer from 'nodemailer';
import { Queue, Worker } from 'bullmq';
import { loadEnv } from './config/env.js';
import { createLogger } from './config/logger.js';
import { createPrisma } from './repositories/prisma.js';
import { createRedis } from './services/redis.js';
import { systemClock } from './services/clock.js';
import { createFieldCipher } from './services/crypto.js';
import { DEFAULT_JOB_OPTIONS, QUEUES } from './queues/index.js';
import { MAINTENANCE_SCHEDULES, createMaintenanceProcessor } from './jobs/maintenance.js';
import { createOutboxRelay } from './jobs/outbox-relay.js';
import { createEmailProcessor } from './jobs/email.js';
import { closeMissedClockOuts, markAbsencesForAllOrganizations } from './modules/attendance/jobs.js';
import { notifyOverdueTasks } from './modules/tasks/tasks.service.js';
import { createStorage } from './services/storage.js';
import { processScreenshot, purgeExpiredScreenshots, sweepStaleUploads } from './modules/monitoring/jobs.js';
import { processDirtyStats, recomputeRecentStats } from './modules/activity/rollup.js';
import { backfillStats, refreshTodayStats } from './modules/activity/stats.js';
import { expireReportJobs, runReportJob } from './modules/reports/reports.service.js';
import { checkSlaBreaches } from './modules/tickets/tickets.service.js';
import { runAccruals, runCarryOver } from './modules/leave/jobs.js';
import { deliverDue, fanOutEvent } from './modules/integrations/webhooks.service.js';
import { createMetrics, registerWorkerMetrics, startMetricsServer } from './services/metrics.js';

process.env.ORBIT_SERVICE ??= 'worker';

let env;
try {
  env = loadEnv();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const RELAY_IDLE_MS = 1000;
const logger = createLogger(env);
const prisma = createPrisma({ logger });
const connection = createRedis(env, { logger });
const prefix = `${env.REDIS_KEY_PREFIX}bull`;
const cipher = createFieldCipher(env.FIELD_ENCRYPTION_KEYS);
const storage = createStorage(env);
const transport = nodemailer.createTransport({
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  secure: env.SMTP_PORT === 465,
  auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
});

const attendanceJobs = {
  // Daily: credit monthly/annual accruals and carry unused leave into a new year (both idempotent per period).
  'leave-accruals': async () => ({ ...(await runCarryOver({ prisma, clock: systemClock, logger })), ...(await runAccruals({ prisma, clock: systemClock, logger })) }),
  'missed-clock-out': () => closeMissedClockOuts({ prisma, clock: systemClock, cipher, env, logger }),
  'mark-absences': () => markAbsencesForAllOrganizations({ prisma, clock: systemClock, logger }),
  // Hourly; each task notifies at most once per local day (dedupe key), so this is idempotent.
  'overdue-tasks': () => notifyOverdueTasks({ prisma, clock: systemClock, cipher, env }),
};

const monitoringDeps = { prisma, storage, clock: systemClock, logger };
const monitoringJobs = {
  'screenshot.process': (job) => processScreenshot(monitoringDeps, job.data),
  // Daily at 02:00 UTC; idempotent and resumable (rows are only marked DELETED after their objects are).
  'screenshot-retention': () => purgeExpiredScreenshots(monitoringDeps),
  'stale-uploads': () => sweepStaleUploads(monitoringDeps),
};

const reportJobs = {
  'report.generate': (job) => runReportJob(monitoringDeps, job.data),
  'stats.backfill': (job) => backfillStats(prisma, { ...job.data, now: systemClock.now() }),
  'stats.refresh': (job) => refreshTodayStats(prisma, { ...job.data, now: systemClock.now() }),
  // Every 5 minutes: rebuild days changed since the last run. Nightly: yesterday and today for everyone.
  'stats-dirty': () => processDirtyStats(prisma, { now: systemClock.now() }),
  'stats-nightly': () => recomputeRecentStats(prisma, { now: systemClock.now(), logger }),
  'report-expiry': () => expireReportJobs(monitoringDeps),
};

const integrationJobs = {
  // An event: create one delivery per subscribed webhook, then try to send right away.
  'webhook.event': async (job) => {
    await fanOutEvent({ prisma, clock: systemClock }, job.data);
    return deliverDue({ prisma, clock: systemClock, cipher, logger });
  },
  // Every minute: retries that have come due (exponential backoff up to 12 h).
  'webhook-deliveries': () => deliverDue({ prisma, clock: systemClock, cipher, logger }),
};

const queues = Object.fromEntries(
  Object.values(QUEUES).map((name) => [name, new Queue(name, { connection, prefix, defaultJobOptions: DEFAULT_JOB_OPTIONS })]),
);

// Repeatable schedules live in Redis, so they survive restarts and run once across replicas.
for (const [name, pattern] of Object.entries(MAINTENANCE_SCHEDULES)) {
  await queues[QUEUES.MAINTENANCE].upsertJobScheduler(name, { pattern }, { name });
}
// Every 15 minutes: close forgotten sessions. Hourly: mark yesterday's absences (each org's own midnight).
await queues[QUEUES.ATTENDANCE].upsertJobScheduler('missed-clock-out', { pattern: '*/15 * * * *' }, { name: 'missed-clock-out' });
await queues[QUEUES.ATTENDANCE].upsertJobScheduler('mark-absences', { pattern: '5 * * * *' }, { name: 'mark-absences' });
await queues[QUEUES.MONITORING].upsertJobScheduler('screenshot-retention', { pattern: '0 2 * * *', tz: 'UTC' }, { name: 'screenshot-retention' });
await queues[QUEUES.MONITORING].upsertJobScheduler('stale-uploads', { pattern: '40 * * * *' }, { name: 'stale-uploads' });
await queues[QUEUES.REPORTS].upsertJobScheduler('stats-dirty', { pattern: '*/5 * * * *' }, { name: 'stats-dirty' });
await queues[QUEUES.REPORTS].upsertJobScheduler('stats-nightly', { pattern: '30 0 * * *', tz: 'UTC' }, { name: 'stats-nightly' });
await queues[QUEUES.REPORTS].upsertJobScheduler('report-expiry', { pattern: '50 * * * *' }, { name: 'report-expiry' });
// Every 10 minutes: flag tickets past their SLA deadlines and tell whoever handles them.
await queues[QUEUES.INTEGRATIONS].upsertJobScheduler('webhook-deliveries', { every: 60_000 }, { name: 'webhook-deliveries' });
await queues[QUEUES.SUPPORT].upsertJobScheduler('sla-breaches', { pattern: '*/10 * * * *' }, { name: 'sla-breaches' });
await queues[QUEUES.ATTENDANCE].upsertJobScheduler('leave-accruals', { pattern: '15 1 * * *', tz: 'UTC' }, { name: 'leave-accruals' });
await queues[QUEUES.ATTENDANCE].upsertJobScheduler('overdue-tasks', { pattern: '20 * * * *' }, { name: 'overdue-tasks' });

const workers = [
  new Worker(QUEUES.MAINTENANCE, createMaintenanceProcessor({ prisma, logger }), { connection, prefix, concurrency: 1 }),
  new Worker(
    QUEUES.ATTENDANCE,
    async (job) => {
      if (!attendanceJobs[job.name]) throw new Error(`Unknown attendance job: ${job.name}`);
      return attendanceJobs[job.name]();
    },
    { connection, prefix, concurrency: 1 },
  ),
  new Worker(
    QUEUES.MONITORING,
    async (job) => {
      if (!monitoringJobs[job.name]) throw new Error(`Unknown monitoring job: ${job.name}`);
      return monitoringJobs[job.name](job);
    },
    // Image processing is CPU-bound; sharp uses its own thread pool per job.
    { connection, prefix, concurrency: 2 },
  ),
  new Worker(
    QUEUES.REPORTS,
    async (job) => {
      if (!reportJobs[job.name]) throw new Error(`Unknown reports job: ${job.name}`);
      return reportJobs[job.name](job);
    },
    { connection, prefix, concurrency: 2 },
  ),
  new Worker(
    QUEUES.INTEGRATIONS,
    async (job) => {
      if (!integrationJobs[job.name]) throw new Error(`Unknown integrations job: ${job.name}`);
      return integrationJobs[job.name](job);
    },
    { connection, prefix, concurrency: 4 },
  ),
  new Worker(QUEUES.SUPPORT, () => checkSlaBreaches({ prisma, clock: systemClock, cipher, env }), { connection, prefix, concurrency: 1 }),
  new Worker(QUEUES.EMAIL, createEmailProcessor({ transport, cipher, env, logger }), {
    connection,
    prefix,
    concurrency: 5,
    limiter: { max: 20, duration: 1000 },
  }),
];

for (const worker of workers) {
  worker.on('failed', (job, err) =>
    logger.error({ queue: worker.name, jobId: job?.id, attempts: job?.attemptsMade, err: err.message }, 'job failed'),
  );
}

let running = true;
const relayOnce = createOutboxRelay({ prisma, queues, logger, clock: systemClock });
const relayLoop = (async () => {
  while (running) {
    try {
      const published = await relayOnce();
      if (published === 0) await new Promise((resolve) => setTimeout(resolve, RELAY_IDLE_MS));
    } catch (err) {
      logger.error({ err }, 'outbox relay failed');
      await new Promise((resolve) => setTimeout(resolve, RELAY_IDLE_MS * 5));
    }
  }
})();

let metricsServer = null;
if (env.METRICS_PORT) {
  const metrics = createMetrics({ service: 'worker' });
  const { collect } = registerWorkerMetrics({ registry: metrics.registry, queues, prisma, workers });
  metricsServer = startMetricsServer({ port: env.METRICS_PORT, registry: metrics.registry, logger, beforeScrape: collect });
}

logger.info({ queues: workers.map((w) => w.name) }, 'worker started');

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  running = false;
  metricsServer?.close();
  logger.info({ signal }, 'worker shutting down');
  await relayLoop;
  // Worker.close() waits for in-flight jobs to finish.
  await Promise.allSettled(workers.map((w) => w.close()));
  await Promise.allSettled([...Object.values(queues).map((q) => q.close()), prisma.$disconnect()]);
  transport.close();
  storage.destroy();
  await connection.quit().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
