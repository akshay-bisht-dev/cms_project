import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineRoutes, listRoutes, mountModule } from '../../src/routes/define-routes.js';
import { PUBLIC } from '../../src/middleware/authorize.js';
import { errorHandler } from '../../src/middleware/error-handler.js';

function mount(module) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.id = 'test-request';
    next();
  });
  const { basePath, router } = mountModule(module);
  app.use(basePath, router);
  app.use(errorHandler());
  return app;
}

describe('defineRoutes', () => {
  it('rejects a route that does not declare a permission', () => {
    expect(() => defineRoutes('/x', (r) => r.get('/', {}, () => {}))).toThrow(/must declare a permission/);
  });

  it('records routes in the registry', () => {
    defineRoutes('/registry-check', (r) => r.get('/item', { permission: PUBLIC, summary: 'x' }, () => {}));
    expect(listRoutes()).toContainEqual(expect.objectContaining({ method: 'get', path: '/registry-check/item' }));
  });

  it('fails closed with 401 for non-public routes when there is no session', async () => {
    const app = mount(defineRoutes('/secure', (r) => r.get('/', { permission: 'employees.read' }, (_q, res) => res.json({}))));
    const res = await request(app).get('/secure');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('validates params, query and body and exposes parsed values on req.valid', async () => {
    const app = mount(
      defineRoutes('/items', (r) =>
        r.post(
          '/:id',
          {
            permission: PUBLIC,
            params: z.object({ id: z.uuid() }),
            query: z.object({ dryRun: z.enum(['true', 'false']).default('false') }),
            body: z.object({ name: z.string().min(1) }).strict(),
          },
          (req, res) => res.json(req.valid),
        ),
      ),
    );

    const bad = await request(app).post('/items/not-a-uuid').send({ name: '', extra: 1 });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
    expect(bad.body.error.details.map((d) => d.path)).toEqual(expect.arrayContaining(['params.id', 'body.name', 'body']));

    const id = '0192f2b0-7c1e-7cc2-9d1a-3b8f0d6a1e11';
    const ok = await request(app).post(`/items/${id}`).send({ name: 'Alpha' });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ params: { id }, query: { dryRun: 'false' }, body: { name: 'Alpha' } });
  });
});
