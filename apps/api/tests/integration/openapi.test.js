import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildTestApp } from '../helpers/test-app.js';
import { listRoutes } from '../../src/routes/define-routes.js';
import { buildOpenApiDocument } from '../../src/modules/docs/openapi.js';

const { app, prisma } = buildTestApp();
afterAll(() => prisma.$disconnect());

describe('OpenAPI', () => {
  it('serves a document covering every registered operation', async () => {
    const res = await request(app).get('/api/openapi.json');
    expect(res.status).toBe(200);
    const operations = Object.values(res.body.paths).flatMap((ops) => Object.keys(ops));
    expect(operations).toHaveLength(listRoutes().length);
    const login = res.body.paths['/api/v1/auth/login'].post;
    expect(login.requestBody.content['application/json'].schema.required).toEqual(['email', 'password']);
    expect(res.body.paths['/api/v1/employees'].post.parameters.some((p) => p.name === 'Idempotency-Key')).toBe(true);
    // Routes that accept API keys say so; the rest do not.
    expect(res.body.paths['/api/v1/employees'].get['x-api-key']).toBe(true);
    expect(res.body.paths['/api/v1/employees'].get.security).toContainEqual({ apiKey: [] });
    expect(res.body.paths['/api/v1/employees'].post['x-api-key']).toBe(false);
  });

  it('matches the committed openapi/openapi.json (run `pnpm --filter @orbit/api openapi` after changing routes)', () => {
    const committed = JSON.parse(readFileSync(new URL('../../openapi/openapi.json', import.meta.url), 'utf8'));
    expect(buildOpenApiDocument(listRoutes())).toEqual(committed);
  });

  it('serves Swagger UI in non-production environments', async () => {
    const res = await request(app).get('/api/docs/').redirects(1);
    expect(res.status).toBe(200);
    expect(res.text).toContain('swagger-ui');
  });
});
