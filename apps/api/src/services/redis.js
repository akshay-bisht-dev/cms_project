import { Redis } from 'ioredis';

/**
 * Shared Redis connection. `maxRetriesPerRequest: null` is required by BullMQ;
 * the API process fails fast via the readiness probe instead of queueing commands forever.
 */
export function createRedis(env, { logger, lazyConnect = false } = {}) {
  const redis = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableOfflineQueue: false,
    lazyConnect,
  });
  redis.on('error', (err) => logger?.warn({ err: err.message }, 'redis connection error'));
  return redis;
}
