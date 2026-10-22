// Generated from the route registry: every route added later is covered automatically.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, createClient } from '../helpers/test-app.js';
import { resetDatabase } from '../helpers/db.js';
import { createMember, createOrg, login } from '../helpers/factories.js';
import { listRoutes } from '../../src/routes/define-routes.js';
import { AGENT, MEMBER, PUBLIC, SESSION } from '../../src/middleware/authorize.js';

const { app, prisma } = buildTestApp();
const PLACEHOLDER_ID = '0192f2b0-7c1e-7cc2-9d1a-3b8f0d6a1e11';
const routes = listRoutes();
const urlFor = (route) => route.path.replace(/:[A-Za-z]+/g, (param) => (param === ':section' ? 'security' : PLACEHOLDER_ID));
const label = (r) => `${r.method.toUpperCase()} ${r.path}`;

let noRoles;
let clientUser;
let apiKey;
beforeAll(async () => {
  await resetDatabase(prisma);
  const ctx = await createOrg(prisma);
  const member = await createMember(prisma, ctx, { role: null });
  noRoles = await login(app, member.user.email);
  // A client portal user holding every permission must still be refused on internal routes.
  const client = await prisma.client.create({ data: { organizationId: ctx.org.id, code: 'ACME', name: 'Acme', defaultCurrency: 'USD' } });
  const portal = await createMember(prisma, ctx, { role: 'OWNER' });
  await prisma.organizationMember.updateMany({ where: { organizationId: ctx.org.id, userId: portal.user.id }, data: { memberType: 'CLIENT', clientId: client.id } });
  clientUser = await login(app, portal.user.email);
  // An API key holding every permission of the owner.
  const owner = await login(app, ctx.owner.email);
  const { PERMISSION_CATALOG } = await import('../../src/modules/rbac/permission-catalog.js');
  apiKey = (await owner.post('/api-keys', { name: 'all', scopes: PERMISSION_CATALOG.map((p) => p.key) })).body.data.key;
});
afterAll(() => prisma.$disconnect());

describe('route registry', () => {
  it('has routes and every route declares an access level', () => {
    expect(routes.length).toBeGreaterThan(50);
    for (const route of routes) expect(route.permission, label(route)).toBeTruthy();
  });
});

describe('unauthenticated requests are rejected', () => {
  it.each(routes.filter((r) => r.permission !== PUBLIC).map((r) => [label(r), r]))('%s → 401', async (_label, route) => {
    const res = await createClient(app)[route.method](urlFor(route), route.method === 'get' ? undefined : {});
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });
});

describe('members without the permission are rejected before validation', () => {
  const gated = routes.filter((r) => ![PUBLIC, SESSION, MEMBER, AGENT].includes(r.permission));
  it.each(gated.map((r) => [label(r), r]))('%s → 403', async (_label, route) => {
    const res = await noRoles[route.method](urlFor(route), route.method === 'get' ? undefined : {});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});

describe('desktop agent routes refuse browser sessions', () => {
  const agentRoutes = routes.filter((r) => r.permission === AGENT);
  it('has agent routes', () => expect(agentRoutes.length).toBeGreaterThan(0));
  it.each(agentRoutes.map((r) => [label(r), r]))('%s → 401 with a session cookie', async (_label, route) => {
    const res = await noRoles[route.method](urlFor(route), {});
    expect(res.status).toBe(401);
  });
});

describe('client portal users reach only routes built for them', () => {
  const internal = routes.filter((r) => ![PUBLIC, SESSION, AGENT].includes(r.permission) && !r.allowClient);
  it('has portal routes', () => expect(routes.filter((r) => r.allowClient).length).toBeGreaterThan(5));
  it.each(internal.map((r) => [label(r), r]))('%s → 403 for a client user (even with every permission)', async (_label, route) => {
    const res = await clientUser[route.method](urlFor(route), route.method === 'get' ? undefined : {});
    expect(res.status).toBe(403);
  });
});

describe('API keys reach only routes opened to them', () => {
  const closed = routes.filter((r) => r.permission !== PUBLIC && !r.apiKey);
  it('has API-key routes', () => expect(routes.filter((r) => r.apiKey).length).toBeGreaterThan(10));
  it.each(closed.map((r) => [label(r), r]))('%s → refused for an API key', async (_label, route) => {
    const { default: request } = await import('supertest');
    const res = await request(app)[route.method](`/api/v1${urlFor(route)}`).set('Authorization', `Bearer ${apiKey}`).send(route.method === 'get' ? undefined : {});
    expect([401, 403]).toContain(res.status);
  });
});
