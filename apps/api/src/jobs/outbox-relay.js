import { OUTBOX_ROUTES } from '../queues/index.js';

/**
 * Moves committed outbox events into BullMQ. Rows are claimed with FOR UPDATE SKIP LOCKED, so
 * several workers can relay concurrently without double-claiming. The BullMQ jobId is the outbox
 * id, so a crash between enqueue and commit re-adds the same job id (a no-op) instead of a duplicate.
 */
export function createOutboxRelay({ prisma, queues, logger, clock, batchSize = 100 }) {
  return async function relayOnce() {
    return prisma.$transaction(
      async (tx) => {
        const claimed = await tx.$queryRaw`
          SELECT id FROM outbox_events
          -- available_at defaults to the database clock, so compare against the same clock.
          WHERE published_at IS NULL AND available_at <= NOW(3)
          ORDER BY created_at
          LIMIT ${batchSize}
          FOR UPDATE SKIP LOCKED`;
        if (claimed.length === 0) return 0;

        const events = await tx.outboxEvent.findMany({ where: { id: { in: claimed.map((r) => r.id) } }, orderBy: { createdAt: 'asc' } });
        const published = [];
        for (const event of events) {
          const queue = queues[OUTBOX_ROUTES[event.type]];
          if (!queue) {
            logger.error({ type: event.type, id: event.id }, 'no queue for outbox event type');
            await tx.outboxEvent.update({ where: { id: event.id }, data: { attempts: { increment: 1 }, lastError: 'no queue for event type' } });
            continue;
          }
          await queue.add(event.type, { outboxId: event.id, ...event.payload }, { jobId: event.id });
          published.push(event.id);
        }
        if (published.length) {
          await tx.outboxEvent.updateMany({ where: { id: { in: published } }, data: { publishedAt: clock.now() } });
        }
        return published.length;
      },
      { timeout: 30_000 },
    );
  };
}
