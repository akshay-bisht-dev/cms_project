const DAY_MS = 86_400_000;

/**
 * Maintenance processors: purge expired, single-use and already-delivered rows so these tables
 * stay small. Each job is idempotent (deleting already-deleted rows is a no-op).
 */
export function createMaintenanceProcessor({ prisma, logger, clock = { now: () => new Date() } }) {
  const ago = (days) => new Date(clock.now().getTime() - days * DAY_MS);
  const tasks = {
    'purge-idempotency-keys': () => prisma.unscoped.idempotencyKey.deleteMany({ where: { expiresAt: { lt: clock.now() } } }),
    'purge-auth-tokens': () => prisma.authToken.deleteMany({ where: { expiresAt: { lt: ago(7) } } }),
    'purge-sessions': () => prisma.userSession.deleteMany({ where: { OR: [{ expiresAt: { lt: ago(180) } }, { revokedAt: { lt: ago(180) } }] } }),
    'purge-outbox': () => prisma.outboxEvent.deleteMany({ where: { publishedAt: { lt: ago(7) } } }),
  };

  return async (job) => {
    const task = tasks[job.name];
    if (!task) throw new Error(`Unknown maintenance job: ${job.name}`);
    const { count } = await task();
    logger.info({ job: job.name, count }, 'maintenance job completed');
    return { deleted: count };
  };
}

export const MAINTENANCE_SCHEDULES = Object.freeze({
  'purge-idempotency-keys': '17 * * * *',
  'purge-auth-tokens': '23 3 * * *',
  'purge-sessions': '31 3 * * *',
  'purge-outbox': '41 3 * * *',
});
