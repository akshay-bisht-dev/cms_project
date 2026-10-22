import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { buildTestApp } from '../helpers/test-app.js';

const { app, prisma } = buildTestApp();
afterAll(() => prisma.$disconnect());

describe('HTTP foundation', () => {
  it('returns the standard error envelope for unknown routes', async () => {
    const res = await request(app).get('/api/v1/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'NOT_FOUND', message: 'No route for GET /api/v1/does-not-exist', details: [] },
      requestId: expect.any(String),
    });
    expect(res.headers['x-request-id']).toBe(res.body.requestId);
  });

  it('propagates a well-formed upstream request id and replaces a malformed one', async () => {
    const kept = await request(app).get('/api/v1/health/live').set('X-Request-Id', 'nginx-abc12345');
    expect(kept.headers['x-request-id']).toBe('nginx-abc12345');

    const replaced = await request(app).get('/api/v1/health/live').set('X-Request-Id', 'bad id with spaces');
    expect(replaced.headers['x-request-id']).not.toBe('bad id with spaces');
  });

  it('rejects malformed JSON with VALIDATION_ERROR', async () => {
    const res = await request(app).post('/api/v1/health/live').set('Content-Type', 'application/json').send('{"broken":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects bodies over the configured limit', async () => {
    const res = await request(app)
      .post('/api/v1/health/live')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ blob: 'x'.repeat(200 * 1024) }));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('sets security headers and hides the framework', async () => {
    const res = await request(app).get('/api/v1/health/live');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
  });
});
