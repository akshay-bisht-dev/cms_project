import pino from 'pino';
import request from 'supertest';
import { loadEnv } from '../../src/config/env.js';
import { createApp } from '../../src/app.js';
import { createPrisma } from '../../src/repositories/prisma.js';
import { createFixedClock } from '../../src/services/clock.js';
import { createMemoryRateLimitStore } from '../../src/services/rate-limiter.js';

/** In-memory stand-ins for dependencies a test does not exercise. */
export const fakeRedis = (reply = 'PONG') => ({ ping: async () => reply, quit: async () => {} });
/**
 * In-memory object storage. Tests simulate a browser upload with `storage.objects.set(key, meta)`;
 * signed URLs are fake but carry the key so tests can find the object.
 */
export const fakeStorage = ({ fail = false } = {}) => {
  const objects = new Map();
  return {
    objects,
    buckets: { files: 'files-test', captures: 'captures-test' },
    ping: async () => {
      if (fail) throw new Error('bucket not reachable');
    },
    presignPut: async ({ key, contentType, contentLength }) => ({ url: `https://storage.test/${key}?put`, method: 'PUT', headers: { 'Content-Type': contentType }, contentLength, expiresAt: new Date(Date.now() + 300_000).toISOString() }),
    presignGet: async ({ key, fileName }) => ({ url: `https://storage.test/${key}?get&name=${encodeURIComponent(fileName)}`, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    head: async ({ key }) => {
      const o = objects.get(key);
      return o ? { contentLength: o.contentLength, contentType: o.contentType } : null;
    },
    getObject: async ({ key }) => {
      const o = objects.get(key);
      if (!o?.body) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
      return o.body;
    },
    putObject: async ({ key, body, contentType }) => {
      objects.set(key, { body, contentLength: body.length, contentType });
    },
    remove: async ({ key }) => {
      objects.delete(key);
    },
    destroy() {},
  };
};

/**
 * Builds the app against the real test database. Redis and storage default to fakes
 * (tests/infra covers the real clients). `clock` controls time for expiry and lockout tests.
 */
export function buildTestApp(overrides = {}) {
  const env = loadEnv({ ...process.env, ...(overrides.env ?? {}) });
  const logger = pino({ level: process.env.TEST_LOG_LEVEL ?? 'silent' });
  const prisma = overrides.prisma ?? createPrisma({ logger });
  const clock = overrides.clock ?? createFixedClock(new Date().toISOString());
  const storage = overrides.storage ?? fakeStorage();
  const app = createApp({
    env,
    logger,
    prisma,
    clock,
    redis: overrides.redis ?? fakeRedis(),
    storage,
    rateLimitStore: overrides.rateLimitStore ?? createMemoryRateLimitStore(),
    metrics: overrides.metrics ?? null,
  });
  return { app, prisma, env, clock, storage };
}

/**
 * A signed-in API client: keeps cookies like a browser and sends the CSRF header on unsafe
 * requests. `client.get('/employees')` → supertest request against /api/v1/employees.
 */
export function createClient(app) {
  const agent = request.agent(app);
  let csrf = null;

  const capture = (res) => {
    for (const cookie of res.headers['set-cookie'] ?? []) {
      const match = /^(?:__Host-)?orbit_csrf=([^;]*)/.exec(cookie);
      if (match) csrf = match[1] || null;
    }
    return res;
  };

  const send = (method) => (path, body, headers = {}) => {
    let req = agent[method](`/api/v1${path}`).set('Origin', 'http://localhost:3000');
    if (csrf && method !== 'get') req = req.set('X-CSRF-Token', csrf);
    for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
    if (body !== undefined) req = req.send(body);
    return req.then(capture);
  };

  return {
    agent,
    get csrf() {
      return csrf;
    },
    get: send('get'),
    post: send('post'),
    put: send('put'),
    patch: send('patch'),
    delete: send('delete'),
  };
}
