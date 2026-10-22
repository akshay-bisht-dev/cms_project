import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp } from '../helpers/test-app.js';
import { resetDatabase } from '../helpers/db.js';
import { createMember, createOrg, login } from '../helpers/factories.js';
import { MAX_ATTEMPTS, deliverDue, fanOutEvent } from '../../src/modules/integrations/webhooks.service.js';
import { verifyWebhook } from '../../src/modules/integrations/webhook-signature.js';
import { postWebhook } from '../../src/modules/integrations/ssrf.js';
import { createFieldCipher } from '../../src/services/crypto.js';

const { app, prisma, clock, env, storage } = buildTestApp();
const cipher = createFieldCipher(env.FIELD_ENCRYPTION_KEYS);
afterAll(() => prisma.$disconnect());
beforeEach(async () => {
  clock.set('2026-10-21T09:00:00Z');
  storage.objects.clear();
  await resetDatabase(prisma);
});

let n = 0;
const key = () => ({ 'Idempotency-Key': `int-test-${Date.now()}-${++n}` });

async function setup() {
  const ctx = await createOrg(prisma);
  const hr = await createMember(prisma, ctx, { role: 'HR_MANAGER', name: 'Hana HR' });
  const emp = await createMember(prisma, ctx, { name: 'Esha Employee' });
  return { ctx, hr, emp, owner: await login(app, ctx.owner.email), hrC: await login(app, hr.user.email), empC: await login(app, emp.user.email) };
}

/** Publishes the outbox's webhook events the way the worker would, then delivers due ones. */
async function pump(transport) {
  const events = await prisma.unscoped.outboxEvent.findMany({ where: { type: 'webhook.event', publishedAt: null } });
  for (const e of events) {
    await fanOutEvent({ prisma, clock }, e.payload);
    await prisma.unscoped.outboxEvent.update({ where: { id: e.id }, data: { publishedAt: new Date() } });
  }
  return deliverDue({ prisma, clock, cipher, transport });
}

function receiver(status = 200) {
  const received = [];
  const transport = async (url, { headers, body }) => {
    received.push({ url, headers, body });
    return { status: typeof status === 'function' ? status(received.length) : status, ms: 5 };
  };
  return { received, transport };
}

describe('webhooks', () => {
  it('delivers subscribed events with a verifiable signature, once per event', async () => {
    const s = await setup();
    const created = await s.owner.post('/webhooks', { url: 'https://hooks.example.test/orbit', events: ['ticket.created', 'invoice.issued'] });
    expect(created.status).toBe(201);
    const { secret } = created.body.data;
    expect(secret).toMatch(/^whsec_/);
    expect(JSON.stringify((await s.owner.get('/webhooks')).body.data)).not.toContain(secret);

    await s.owner.post('/support-tickets', { subject: 'Printer on fire', description: 'Again' }, key());
    await s.owner.post('/clients', { name: 'Unsubscribed Event Co' }, key());
    const r = receiver();
    expect(await pump(r.transport)).toEqual({ attempted: 1, delivered: 1 });
    expect(r.received).toHaveLength(1);
    const [msg] = r.received;
    const event = verifyWebhook({ secret, headers: msg.headers, body: msg.body, now: clock.now().getTime() });
    expect(event).toMatchObject({ type: 'ticket.created', organizationId: s.ctx.org.id, data: { number: 1, priority: 'NORMAL' } });

    // Fan-out is idempotent: re-processing the same event creates no second delivery.
    const outbox = await prisma.outboxEvent.findFirst({ where: { organizationId: s.ctx.org.id, type: 'webhook.event' } });
    await fanOutEvent({ prisma, clock }, outbox.payload);
    expect(await prisma.webhookDelivery.count({ where: { organizationId: s.ctx.org.id } })).toBe(1);
    const deliveries = (await s.owner.get(`/webhooks/${created.body.data.id}/deliveries`)).body.data;
    expect(deliveries[0]).toMatchObject({ status: 'SUCCEEDED', attempt: 1, statusCode: 200, eventType: 'ticket.created' });
  });

  it('retries with backoff, gives up after the last attempt, and replays with a fresh nonce', async () => {
    const s = await setup();
    const hook = (await s.owner.post('/webhooks', { url: 'https://hooks.example.test/orbit', events: ['*'] })).body.data;
    await s.owner.post('/webhooks/' + hook.id + '/ping');
    const failing = receiver(503);
    await deliverDue({ prisma, clock, cipher, transport: failing.transport });
    let d = await prisma.webhookDelivery.findFirst({ where: { organizationId: s.ctx.org.id } });
    expect(d).toMatchObject({ status: 'PENDING', attempt: 1, statusCode: 503, error: 'HTTP 503' });
    expect(d.nextRetryAt.getTime() - clock.now().getTime()).toBe(60_000);
    expect(await deliverDue({ prisma, clock, cipher, transport: failing.transport })).toEqual({ attempted: 0, delivered: 0 }); // not due yet
    for (const delay of [60, 300, 1800, 7200, 43200]) {
      clock.advance(delay * 1000 + 1000);
      await deliverDue({ prisma, clock, cipher, transport: failing.transport });
    }
    d = await prisma.webhookDelivery.findFirst({ where: { organizationId: s.ctx.org.id } });
    expect(d).toMatchObject({ status: 'FAILED', attempt: MAX_ATTEMPTS, nextRetryAt: null });
    expect((await prisma.webhook.findFirst({ where: { organizationId: s.ctx.org.id } })).consecutiveFailures).toBe(1);

    const owner = await login(app, s.ctx.owner.email);
    const replay = await owner.post(`/webhooks/${hook.id}/deliveries/${d.id}/replay`);
    expect(replay.status).toBe(201);
    const ok = receiver();
    await deliverDue({ prisma, clock, cipher, transport: ok.transport });
    // The receiver accepts the replay (new delivery id) but would refuse the same delivery twice.
    const seen = new Set([d.id]);
    const secret = cipher.decrypt((await prisma.webhook.findFirst({ where: { organizationId: s.ctx.org.id } })).secretEnc);
    expect(verifyWebhook({ secret, headers: ok.received[0].headers, body: ok.received[0].body, now: clock.now().getTime(), seen })).toMatchObject({ type: 'ping' });
    expect(() => verifyWebhook({ secret, headers: ok.received[0].headers, body: ok.received[0].body, now: clock.now().getTime(), seen })).toThrow(/replay/);
  });

  it('refuses to connect to private addresses even when a public name resolves to one', async () => {
    const s = await setup();
    const hook = (await s.owner.post('/webhooks', { url: 'https://rebind.example.test/hook', events: ['*'] })).body.data;
    await s.owner.post(`/webhooks/${hook.id}/ping`);
    const rebinding = (url, opts) => postWebhook(url, { ...opts, lookup: (_host, _o, cb) => cb(null, '169.254.169.254', 4) });
    await deliverDue({ prisma, clock, cipher, transport: rebinding });
    const d = await prisma.webhookDelivery.findFirst({ where: { organizationId: s.ctx.org.id } });
    expect(d.error).toMatch(/EBLOCKED.*private address/);
    expect((await s.owner.post('/webhooks', { url: 'https://10.0.0.5/hook', events: ['*'] })).status).toBe(400);
    expect((await s.owner.post('/webhooks', { url: 'https://hooks.example.test/x', events: ['made.up'] })).status).toBe(400);
  });

  it('is managed only with webhooks.manage', async () => {
    const s = await setup();
    expect((await s.empC.get('/webhooks')).status).toBe(403);
    expect((await s.hrC.post('/webhooks', { url: 'https://hooks.example.test/x', events: ['*'] })).status).toBe(403);
  });
});

describe('API keys', () => {
  const as = (k) => ({ get: (p) => request(app).get(`/api/v1${p}`).set('Authorization', `Bearer ${k}`), post: (p, b, h = {}) => request(app).post(`/api/v1${p}`).set('Authorization', `Bearer ${k}`).set(h).send(b) });

  it('authenticates scoped keys on integration routes only', async () => {
    const s = await setup();
    const created = await s.owner.post('/api-keys', { name: 'HRIS sync', scopes: ['employees.read', 'projects.read', 'tickets.read', 'tickets.manage'] });
    expect(created.status).toBe(201);
    const k = created.body.data.key;
    expect(k).toMatch(/^orb_[a-z0-9]{12}_[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify((await s.owner.get('/api-keys')).body.data)).not.toContain(k);
    const api = as(k);

    expect((await api.get('/employees')).status).toBe(200);
    expect((await api.get('/projects')).status).toBe(200);
    expect((await api.get('/clients')).status).toBe(403); // route allows keys, scope does not
    expect((await api.get('/audit-logs')).status).toBe(403); // route not open to keys
    expect((await api.get('/auth/me')).status).toBe(403);
    expect((await api.get('/webhooks')).status).toBe(403);
    const ticket = await api.post('/support-tickets', { subject: 'From the API', description: 'x' }, key());
    expect(ticket.status).toBe(201);
    const audit = await prisma.auditLog.findFirst({ where: { organizationId: s.ctx.org.id, action: 'tickets.created' } });
    expect(audit).toMatchObject({ actorType: 'API_KEY', actorId: created.body.data.id });

    // With a session cookie as well, the request is refused.
    expect((await s.owner.get('/employees', undefined, { Authorization: `Bearer ${k}` })).status).toBe(401);
  });

  it('cannot exceed its creator, follows the creator’s current permissions, expires and revokes', async () => {
    const s = await setup();
    // HR holds no finance permissions, so cannot mint a key with them (and lacks apikeys.manage anyway).
    expect((await s.hrC.post('/api-keys', { name: 'x', scopes: ['employees.read'] })).status).toBe(403);
    const admin = await createMember(prisma, s.ctx, { role: 'HR_MANAGER', name: 'Integrator' });
    const role = await prisma.role.create({ data: { organizationId: s.ctx.org.id, key: 'INTEGRATOR', name: 'Integrator' } });
    await prisma.rolePermission.createMany({ data: ['apikeys.manage', 'employees.read'].map((permissionKey) => ({ organizationId: s.ctx.org.id, roleId: role.id, permissionKey, scope: 'ORG' })) });
    await prisma.memberRole.create({ data: { organizationId: s.ctx.org.id, userId: admin.user.id, roleId: role.id } });
    const integrator = await login(app, admin.user.email);
    expect((await integrator.post('/api-keys', { name: 'too wide', scopes: ['finance.invoices.read'] })).status).toBe(400);
    const k = (await integrator.post('/api-keys', { name: 'sync', scopes: ['employees.read'], expiresInDays: 30 })).body.data;
    const api = as(k.key);
    expect((await api.get('/employees')).status).toBe(200);

    // The creator loses the permission → so does the key.
    await prisma.memberRole.deleteMany({ where: { organizationId: s.ctx.org.id, userId: admin.user.id } });
    expect((await api.get('/employees')).status).toBe(403);
    await prisma.memberRole.create({ data: { organizationId: s.ctx.org.id, userId: admin.user.id, roleId: role.id } });
    expect((await api.get('/employees')).status).toBe(200);

    clock.advance(31 * 86_400_000);
    expect((await api.get('/employees')).status).toBe(401);
    clock.set('2026-10-21T09:00:00Z');
    expect((await s.owner.post(`/api-keys/${k.id}/revoke`)).status).toBe(204);
    expect((await api.get('/employees')).status).toBe(401);
    expect((await as(`${k.key.slice(0, -1)}x`).get('/employees')).status).toBe(401);
  });
});

describe('custom fields', () => {
  it('validates typed values and follows the record’s own access rules', async () => {
    const s = await setup();
    const size = await s.owner.post('/custom-fields', { entity: 'EMPLOYEE', key: 'tshirt_size', label: 'T-shirt size', type: 'SELECT', options: ['S', 'M', 'L'] });
    expect(size.status).toBe(201);
    await s.owner.post('/custom-fields', { entity: 'EMPLOYEE', key: 'bonus', label: 'Signing bonus', type: 'NUMBER' });
    await s.owner.post('/custom-fields', { entity: 'PROJECT', key: 'contract_ref', label: 'Contract reference', type: 'TEXT', required: true });
    expect((await s.owner.post('/custom-fields', { entity: 'EMPLOYEE', key: 'tshirt_size', label: 'dup', type: 'TEXT' })).status).toBe(409);

    const path = `/custom-fields/values/EMPLOYEE/${s.emp.employeeId}`;
    expect((await s.hrC.put(path, { values: { tshirt_size: 'XL' } })).status).toBe(400);
    expect((await s.hrC.put(path, { values: { bonus: '1.23456' } })).status).toBe(400);
    expect((await s.hrC.put(path, { values: { nope: 'x' } })).status).toBe(400);
    const saved = (await s.hrC.put(path, { values: { tshirt_size: 'M', bonus: '2500.50' } })).body.data;
    expect(saved.map((f) => [f.key, f.value])).toEqual([['bonus', '2500.5'], ['tshirt_size', 'M']]);
    const asEmployee = (await s.empC.get(path)).body;
    expect(asEmployee.data.find((f) => f.key === 'tshirt_size').value).toBe('M');
    expect(asEmployee.meta.canEdit).toBe(false);
    expect((await s.hrC.get(path)).body.meta.canEdit).toBe(true);
    expect((await s.empC.put(path, { values: { tshirt_size: 'S' } })).status).toBe(403);

    const project = (await s.owner.post('/projects', { name: 'Fielded' }, key())).body.data;
    const ppath = `/custom-fields/values/PROJECT/${project.id}`;
    expect((await s.owner.put(ppath, { values: { contract_ref: '' } })).status).toBe(400); // required
    expect((await s.owner.put(ppath, { values: { contract_ref: 'MSA-42' } })).body.data[0].value).toBe('MSA-42');
    expect((await s.empC.put(ppath, { values: { contract_ref: 'x' } })).status).toBeGreaterThanOrEqual(403);

    const other = await createOrg(prisma);
    const outsider = await login(app, other.owner.email);
    expect((await outsider.get(path)).status).toBe(404);
  });
});

describe('HR documents and checklists', () => {
  it('stores private documents with visibility rules and audited downloads', async () => {
    const s = await setup();
    const docs = `/employees/${s.emp.employeeId}/documents`;
    const upload = async (title, visibility) => {
      const u = (await s.hrC.post(`${docs}/uploads`, { fileName: `${title}.pdf`, contentType: 'application/pdf', sizeBytes: 1200 })).body.data;
      const file = await prisma.fileObject.findFirst({ where: { organizationId: s.ctx.org.id, id: u.fileId } });
      storage.objects.set(file.storageKey, { contentLength: 1200, contentType: 'application/pdf' });
      return s.hrC.post(docs, { fileId: u.fileId, type: 'CONTRACT', title, visibility, expiresOn: '2026-11-01' });
    };
    expect((await upload('Contract', 'EMPLOYEE')).status).toBe(201);
    const secret = (await upload('Background check', 'HR_ONLY')).body.data;
    expect((await s.hrC.get(docs)).body.data).toHaveLength(2);
    const own = (await s.empC.get(docs)).body.data;
    expect(own.map((d) => d.title)).toEqual(['Contract']);
    expect((await s.empC.get(`${docs}/${secret.id}/download`)).status).toBe(404);
    expect((await s.hrC.get(`${docs}/${secret.id}/download`)).body.data.url).toMatch(/hr-document/);
    expect(await prisma.auditLog.count({ where: { organizationId: s.ctx.org.id, action: 'documents.downloaded' } })).toBe(1);
    const peer = await createMember(prisma, s.ctx, { name: 'Pat Peer' });
    expect((await (await login(app, peer.user.email)).get(docs)).status).toBe(403);
    expect((await s.hrC.get('/hr/documents/expiring?days=30')).body.data).toHaveLength(2);
  });

  it('starts onboarding on invite and offboarding on exit; tasks belong to their assignees', async () => {
    const s = await setup();
    const invited = await s.hrC.post('/employees', { email: 'new.hire@example.test', name: 'New Hire', managerEmployeeId: s.emp.employeeId }, key());
    expect(invited.status).toBe(201);
    const id = invited.body.data.employee.employeeId;
    const [onboarding] = (await s.hrC.get(`/employees/${id}/checklists`)).body.data;
    expect(onboarding).toMatchObject({ kind: 'ONBOARDING', completedAt: null });
    expect(onboarding.tasks.map((t) => [t.title, t.assigneeRole])).toEqual([
      ['Sign the employment contract', 'HR'],
      ['Set up laptop and accounts', 'MANAGER'],
      ['Complete your profile', 'EMPLOYEE'],
      ['Introduce the team and first tasks', 'MANAGER'],
    ]);
    // The manager (Esha) sees their tasks; HR sees the HR pool.
    const mine = (await s.empC.get('/checklist-tasks')).body.data;
    expect(mine.map((t) => t.title)).toEqual(['Set up laptop and accounts', 'Introduce the team and first tasks']);
    expect((await s.hrC.get('/checklist-tasks')).body.data.map((t) => t.title)).toContain('Sign the employment contract');
    const hrTask = onboarding.tasks[0];
    expect((await s.empC.post(`/checklist-tasks/${hrTask.id}/done`, { done: true })).status).toBe(403);
    for (const t of onboarding.tasks) {
      const client = t.assigneeRole === 'MANAGER' ? s.empC : s.hrC;
      await client.post(`/checklist-tasks/${t.id}/done`, { done: true });
    }
    expect((await s.hrC.get(`/employees/${id}/checklists`)).body.data[0].completedAt).not.toBeNull();

    expect((await s.owner.post(`/employees/${s.emp.employeeId}/offboard`, { lastWorkingDate: '2026-10-31' }, key())).status).toBe(200);
    const exit = (await s.hrC.get(`/employees/${s.emp.employeeId}/checklists`)).body.data;
    expect(exit.map((c) => c.kind)).toContain('OFFBOARDING');
  });
});

describe('audit log', () => {
  it('lists the trail with filters for auditors only', async () => {
    const s = await setup();
    await s.owner.post('/webhooks', { url: 'https://hooks.example.test/a', events: ['*'] });
    await s.owner.post('/custom-fields', { entity: 'CLIENT', key: 'tier', label: 'Tier', type: 'TEXT' });
    const page = (await s.owner.get('/audit-logs?action=webhooks.&limit=10')).body;
    expect(page.data.map((r) => r.action)).toEqual(['webhooks.created']);
    expect(page.data[0].actor).toMatchObject({ type: 'USER', name: expect.stringContaining('Owner') });
    const first = await s.owner.get('/audit-logs?limit=1');
    expect(first.body.meta.page.nextCursor).toBeTruthy();
    const second = await s.owner.get(`/audit-logs?limit=1&cursor=${encodeURIComponent(first.body.meta.page.nextCursor)}`);
    expect(second.body.data[0].id).not.toBe(first.body.data[0].id);
    expect((await s.empC.get('/audit-logs')).status).toBe(403);
  });
});
