import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { buildTestApp, fakeRedis, fakeStorage } from '../helpers/test-app.js';

const apps = [];
function build(overrides) {
  const built = buildTestApp(overrides);
  apps.push(built);
  return built.app;
}
afterAll(() => Promise.all(apps.map((a) => a.prisma.$disconnect())));

describe('GET /api/v1/health/live', () => {
  it('reports the process as live', async () => {
    const res = await request(build()).get('/api/v1/health/live');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { status: 'live' } });
  });
});

describe('GET /api/v1/health/ready', () => {
  it('is ready when the migrated database and other dependencies respond', async () => {
    const res = await request(build()).get('/api/v1/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ready');
    expect(res.body.data.checks.database.status).toBe('up');
  });

  it('returns 503 naming only the failing dependency, without internal error text', async () => {
    const res = await request(build({ redis: fakeRedis('NOPE'), storage: fakeStorage({ fail: true }) })).get(
      '/api/v1/health/ready',
    );
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('UNAVAILABLE');
    expect(res.body.error.details).toEqual([
      { path: 'redis', message: 'unavailable' },
      { path: 'storage', message: 'unavailable' },
    ]);
    expect(JSON.stringify(res.body)).not.toMatch(/bucket not reachable|NOPE/);
  });
});
