// Prints every SQL statement slower than 50 ms (PROFILE_MIN_MS) while calling endpoints in-process.
//   DATABASE_URL_PERF=… node scripts/perf/query-profile.js owner@acme-it.test /dashboard/summary /projects
// Use it to see the exact SQL behind a slow endpoint before reaching for EXPLAIN (docs/performance.md).
import request from 'supertest';
import pino from 'pino';
import { PrismaClient } from '@prisma/client';
import { loadEnv } from '../../src/config/env.js';
import { createApp } from '../../src/app.js';
import { createMemoryRateLimitStore } from '../../src/services/rate-limiter.js';

const url = process.env.DATABASE_URL_PERF ?? 'mysql://orbit_app:orbit_app_dev@127.0.0.1:3306/orbit_perf_test';
const MIN_MS = Number(process.env.PROFILE_MIN_MS ?? 50);
const prisma = new PrismaClient({ datasourceUrl: url, log: [{ emit: 'event', level: 'query' }] });
prisma.unscoped = prisma;
let current = '';
const slow = [];
const counts = {};
prisma.$on('query', (e) => { counts[current] = (counts[current] ?? { n: 0, ms: 0 }); counts[current].n += 1; counts[current].ms += e.duration; if (e.duration > MIN_MS) slow.push({ endpoint: current, ms: e.duration, sql: e.query.replace(/`orbit_perf_test`\./g, ''), params: e.params.slice(0, 300) }); });
const env = loadEnv({ ...process.env, DATABASE_URL: url, NODE_ENV: 'development', RATE_LIMIT_ENABLED: 'false' });
const redis = { ping: async () => 'PONG', get: async () => null, set: async () => 'OK', del: async () => 0, multi: () => ({ incr() { return this; }, pttl() { return this; }, exec: async () => [[null, 1], [null, 60000]] }), pexpire: async () => 1, quit: async () => {} };
const storage = { buckets: {}, ping: async () => true, destroy() {} };
const app = createApp({ env, logger: pino({ level: 'silent' }), prisma, redis, storage, rateLimitStore: createMemoryRateLimitStore() });
const agent = request.agent(app);
await agent.post('/api/v1/auth/login').send({ email: process.argv[2] ?? 'owner@acme-it.test', password: process.env.PERF_PASSWORD ?? 'Perf-Passphrase-2026' }).expect(200);
const day = (o = 0) => new Date(Date.now() + o * 864e5).toISOString().slice(0, 10);
for (const path of process.argv.slice(3).length ? process.argv.slice(3) : ['/dashboard/summary', `/calendar?from=${day(-15)}&to=${day(15)}`, '/projects', '/activity/trends?weeks=8', `/reports/time?from=${day(-30)}&to=${day(-1)}&groupBy=member`, '/employees?q=perf%2012&limit=25']) {
  current = path;
  const t = Date.now();
  const res = await agent.get(`/api/v1${path}`);
  process.stdout.write(`${res.status} ${Date.now() - t} ms ${path} — ${counts[path]?.n ?? 0} queries, ${counts[path]?.ms ?? 0} ms in SQL\n`);
}
for (const s of slow) process.stdout.write(`\n[${s.endpoint}] ${s.ms} ms\n${s.sql.slice(0, 1500)}\nparams ${s.params}\n`);
await prisma.$disconnect();
