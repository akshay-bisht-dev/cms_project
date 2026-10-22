import { createServer } from 'node:http';
import { loadEnv } from './config/env.js';
import { createLogger } from './config/logger.js';
import { createPrisma } from './repositories/prisma.js';
import { createRedis } from './services/redis.js';
import { createStorage } from './services/storage.js';
import { createApp } from './app.js';
import { createRedisRateLimitStore } from './services/rate-limiter.js';
import { createRealtimeHub } from './sockets/realtime.js';
import { createSessionService } from './modules/auth/session.service.js';
import { systemClock } from './services/clock.js';
import { syncPermissionCatalog } from './modules/rbac/index.js';
import { createMetrics, startMetricsServer } from './services/metrics.js';

const SHUTDOWN_GRACE_MS = 25000;

let env;
try {
  env = loadEnv();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const logger = createLogger(env);
const prisma = createPrisma({ logger });
const redis = createRedis(env, { logger });
const storage = createStorage(env);
// Idempotent upsert of the code-defined permission catalog, so roles always reference known keys.
await syncPermissionCatalog(prisma);
const rateLimitStore = createRedisRateLimitStore(redis, `${env.REDIS_KEY_PREFIX}rl:`);
const realtime = createRealtimeHub({ env, prisma, sessionService: createSessionService({ prisma, env, clock: systemClock }), logger });
const metrics = env.METRICS_PORT ? createMetrics({ service: 'api' }) : null;
const app = createApp({ env, logger, prisma, redis, storage, rateLimitStore, realtime, metrics });
const metricsServer = metrics ? startMetricsServer({ port: env.METRICS_PORT, registry: metrics.registry, logger }) : null;

const server = createServer(app);
realtime.attach(server);
server.keepAliveTimeout = 65000; // longer than typical LB idle timeouts
server.headersTimeout = 66000;

server.listen(env.PORT, () => logger.info({ port: env.PORT }, 'api listening'));

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  const force = setTimeout(() => {
    logger.error('graceful shutdown timed out; forcing exit');
    process.exit(1);
  }, SHUTDOWN_GRACE_MS);
  force.unref();

  metricsServer?.close();
  server.close(async () => {
    await Promise.allSettled([realtime.close(), prisma.$disconnect(), redis.quit()]);
    storage.destroy();
    logger.info('shutdown complete');
    process.exit(0);
  });
  server.closeIdleConnections();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'unhandled rejection'));
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception');
  process.exit(1);
});
