// Exercises the real Redis and S3 clients. Requires `docker compose up -d`.
import { once } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import request from 'supertest';
import { loadEnv } from '../../src/config/env.js';
import { createApp } from '../../src/app.js';
import { createPrisma } from '../../src/repositories/prisma.js';
import { createRedis } from '../../src/services/redis.js';
import { createStorage } from '../../src/services/storage.js';

const env = loadEnv(process.env);
const logger = pino({ level: 'silent' });
const prisma = createPrisma({ logger });
const redis = createRedis(env, { logger });
const storage = createStorage(env);

// The client connects asynchronously and queues nothing while offline (enableOfflineQueue: false):
// probing readiness before it is connected would report Redis down.
beforeAll(async () => {
  if (redis.status !== 'ready') await once(redis, 'ready');
}, 20_000);

afterAll(async () => {
  await prisma.$disconnect();
  // quit() rejects on a client that never connected; disconnect() does not.
  redis.disconnect();
  storage.destroy();
});

describe('real infrastructure', () => {
  it('reports ready with real MySQL, Redis and object storage', async () => {
    const app = createApp({ env, logger, prisma, redis, storage });
    const res = await request(app).get('/api/v1/health/ready');
    expect(res.body.data?.checks ?? res.body.error).toMatchObject({
      database: { status: 'up' },
      redis: { status: 'up' },
      storage: { status: 'up' },
    });
    expect(res.status).toBe(200);
  });
});
