const CHECK_TIMEOUT_MS = 2000;

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Readiness = every hard dependency answers within the timeout and the schema is migrated.
 * Each check is reported individually so operators can see which dependency failed.
 */
export function createHealthService({ prisma, redis, storage, clock = () => new Date() }) {
  const checks = {
    database: async () => {
      await prisma.$queryRaw`SELECT 1`;
      const [{ pending }] = await prisma.$queryRaw`
        SELECT COUNT(*) AS pending FROM _prisma_migrations
        WHERE finished_at IS NULL AND rolled_back_at IS NULL`;
      if (Number(pending) > 0) throw new Error('migrations in progress or failed');
    },
    redis: async () => {
      const reply = await redis.ping();
      if (reply !== 'PONG') throw new Error(`unexpected reply ${reply}`);
    },
    storage: () => storage.ping(),
  };

  return {
    async readiness() {
      const entries = await Promise.all(
        Object.entries(checks).map(async ([name, check]) => {
          const started = performance.now();
          try {
            await withTimeout(check(), CHECK_TIMEOUT_MS);
            return [name, { status: 'up', latencyMs: Math.round(performance.now() - started) }];
          } catch (err) {
            return [name, { status: 'down', error: err.message }];
          }
        }),
      );
      const results = Object.fromEntries(entries);
      const ready = Object.values(results).every((r) => r.status === 'up');
      return { status: ready ? 'ready' : 'not_ready', checkedAt: clock().toISOString(), checks: results };
    },
  };
}
