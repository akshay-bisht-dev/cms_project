import { afterAll, describe, expect, it } from 'vitest';
import { buildTestApp } from '../helpers/test-app.js';
import { resetDatabase } from '../helpers/db.js';
import { createOrg, login } from '../helpers/factories.js';
import { createMetrics, registerWorkerMetrics, startMetricsServer } from '../../src/services/metrics.js';

const metrics = createMetrics({ service: 'api' });
const { app, prisma } = buildTestApp({ metrics });
const servers = [];
afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  await prisma.$disconnect();
});

describe('metrics', () => {
  it('labels HTTP latency by route pattern, never by raw ids', async () => {
    await resetDatabase(prisma.unscoped);
    const ctx = await createOrg(prisma);
    const owner = await login(app, ctx.owner.email);
    const list = (await owner.get('/employees')).body.data;
    await owner.get(`/employees/${list[0].employeeId}`);
    await owner.get('/no-such-route');
    const text = await metrics.registry.metrics();
    expect(text).toMatch(/http_request_duration_seconds_count\{[^}]*route="\/api\/v1\/employees\/:employeeId"[^}]*status_class="2xx"/);
    expect(text).toMatch(/route="unmatched"[^}]*status_class="4xx"/);
    expect(text).not.toContain(list[0].employeeId);
    expect(text).toContain('service="api"');
  });

  it('serves only GET /metrics on the internal server, refreshing worker gauges on scrape', async () => {
    const registry = createMetrics({ service: 'worker' }).registry;
    const queue = { name: 'email', getJobCounts: async () => ({ waiting: 3, active: 1, delayed: 0, failed: 2 }) };
    const { collect } = registerWorkerMetrics({ registry, queues: { email: queue }, prisma: prisma.unscoped, workers: [] });
    await prisma.unscoped.outboxEvent.create({ data: { type: 'test.event', payload: {}, dedupeKey: 'metrics-test', availableAt: new Date(Date.now() - 90_000) } });
    const server = startMetricsServer({ port: 0, registry, beforeScrape: collect });
    servers.push(server);
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${base}/metrics`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toMatch(/queue_jobs\{[^}]*queue="email"[^}]*state="failed"[^}]*\} 2/);
    expect(text).toMatch(/outbox_pending\{[^}]*\} 1/);
    expect(Number(/outbox_oldest_pending_seconds\{[^}]*\} ([\d.]+)/.exec(text)[1])).toBeGreaterThanOrEqual(85);
    expect(text).toMatch(/metrics_source_up\{[^}]*source="database"[^}]*\} 1/);
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/metrics`, { method: 'POST' })).status).toBe(404);
  });
});
