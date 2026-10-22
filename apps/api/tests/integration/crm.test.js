import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp } from '../helpers/test-app.js';
import { resetDatabase } from '../helpers/db.js';
import { createMember, createOrg, lastEmail, login, PASSWORD } from '../helpers/factories.js';
import { checkSlaBreaches } from '../../src/modules/tickets/tickets.service.js';
import { createFieldCipher } from '../../src/services/crypto.js';
import { createClient } from '../helpers/test-app.js';

const { app, prisma, clock, env } = buildTestApp();
const cipher = createFieldCipher(env.FIELD_ENCRYPTION_KEYS);
afterAll(() => prisma.$disconnect());
beforeEach(async () => {
  clock.set('2026-10-21T09:00:00Z'); // Wednesday
  await resetDatabase(prisma);
});

let n = 0;
const key = () => ({ 'Idempotency-Key': `crm-test-${Date.now()}-${++n}` });

async function setup() {
  const ctx = await createOrg(prisma);
  const owner = await login(app, ctx.owner.email);
  const agentMember = await createMember(prisma, ctx, { name: 'Sam Support' });
  const pm = await createMember(prisma, ctx, { role: 'PROJECT_MANAGER', name: 'Pam PM' });
  const client = (await owner.post('/clients', { name: 'Globex Corporation', defaultCurrency: 'USD', status: 'ACTIVE' }, key())).body.data;
  const otherClient = (await owner.post('/clients', { name: 'Initech', defaultCurrency: 'USD', status: 'ACTIVE' }, key())).body.data;
  return { ctx, owner, agentMember, pm, client, otherClient };
}

/** Invites a portal user through the API and accepts the invitation like the person would. */
async function portalUser(s, clientId, email) {
  const invite = await s.owner.post(`/clients/${clientId}/portal-users`, { email, name: 'Carla Client' }, key());
  expect(invite.status).toBe(201);
  const { token } = await lastEmail(prisma, cipher, email);
  const accepted = await createClient(app).post('/auth/accept-invitation', { token, password: PASSWORD, name: 'Carla Client' });
  expect(accepted.status).toBeLessThan(300);
  return login(app, email);
}

describe('clients', () => {
  it('creates clients with generated codes and limits project managers to their projects’ clients', async () => {
    const s = await setup();
    expect(s.client.code).toBe('GC');
    expect(s.otherClient.code).toBe('INITE');
    const dup = await s.owner.post('/clients', { name: 'Another', code: 'gc' }, key());
    expect(dup.status).toBe(409);
    await s.owner.post(`/clients/${s.client.id}/contacts`, { name: 'Gina', email: 'gina@globex.test', isPrimary: true });
    await s.owner.post(`/clients/${s.client.id}/notes`, { kind: 'CALL', body: 'Kick-off call' });

    const pm = await login(app, s.pm.user.email);
    expect((await pm.get('/clients')).body.data).toHaveLength(0);
    await s.owner.post('/projects', { name: 'Globex Portal', clientId: s.client.id, managerEmployeeId: s.pm.employeeId }, key());
    const visible = (await pm.get('/clients')).body.data;
    expect(visible.map((c) => c.name)).toEqual(['Globex Corporation']);
    expect((await pm.get(`/clients/${s.otherClient.id}`)).status).toBe(404);
    const detail = (await pm.get(`/clients/${s.client.id}`)).body.data;
    expect(detail.contacts[0]).toMatchObject({ name: 'Gina', isPrimary: true });
    expect(detail).not.toHaveProperty('outstanding'); // no finance permission
    expect((await pm.patch(`/clients/${s.client.id}`, { name: 'x' })).status).toBe(403);
  });
});

describe('leads and pipeline', () => {
  it('follows the lead workflow and converts once into client, contact and opportunity', async () => {
    const s = await setup();
    const lead = (await s.owner.post('/leads', { name: 'Dana Lee', company: 'Hooli', email: 'dana@hooli.test', source: 'Website', estimatedValue: '25000', currency: 'USD' }, key())).body.data;
    expect((await s.owner.patch(`/leads/${lead.id}`, { status: 'LOST' })).status).toBe(400); // needs a reason
    expect((await s.owner.patch(`/leads/${lead.id}`, { status: 'QUALIFIED' })).body.data.status).toBe('QUALIFIED');
    const converted = await s.owner.post(`/leads/${lead.id}/convert`, {}, key());
    expect(converted.status).toBe(201);
    expect(converted.body.data.client).toMatchObject({ name: 'Hooli', code: 'HOOLI' });
    const again = await s.owner.post(`/leads/${lead.id}/convert`, {}, key());
    expect(again.status).toBe(409);
    const client = (await s.owner.get(`/clients/${converted.body.data.client.id}`)).body.data;
    expect(client.contacts).toEqual([expect.objectContaining({ name: 'Dana Lee', isPrimary: true })]);
    const opps = (await s.owner.get(`/opportunities?clientId=${client.id}`)).body.data;
    expect(opps[0]).toMatchObject({ value: '25000.00', probability: 10, stage: { name: 'Prospecting' } });
  });

  it('values the pipeline in the base currency and weights the forecast', async () => {
    const s = await setup();
    const stages = (await s.owner.get('/pipeline-stages')).body.data;
    const stage = (name) => stages.find((x) => x.name === name).id;
    const opp = (body) => s.owner.post('/opportunities', { clientId: s.client.id, ...body }, key());
    await opp({ name: 'A', value: '10000', currency: 'USD', stageId: stage('Proposal'), expectedCloseDate: '2026-11-15' }); // 50 %
    await opp({ name: 'B', value: '1000', currency: 'EUR', stageId: stage('Negotiation'), expectedCloseDate: '2026-11-20' }); // 75 %
    await opp({ name: 'C', value: '5000', currency: 'GBP', stageId: stage('Qualification') }); // no rate → unconverted
    const lost = await opp({ name: 'D', value: '900', currency: 'USD', stageId: stage('Lost') });
    expect(lost.status).toBe(400); // needs a reason
    const fin = await login(app, (await createMember(prisma, s.ctx, { role: 'FINANCE_MANAGER' })).user.email);
    await fin.post('/exchange-rates', { currency: 'EUR', rateToBase: '1.08', effectiveFrom: '2026-01-01' });

    const p = (await s.owner.get('/pipeline?from=2026-11-01&to=2026-11-30')).body.data;
    expect(p.pipelineValue).toEqual({ value: '11080.00', kind: 'measured' });
    expect(p.weightedForecast).toMatchObject({ value: '5810.00', kind: 'estimated' }); // 5000 + 810
    expect(p.unconvertedCurrencies).toEqual(['GBP']);
  });
});

describe('quotes', () => {
  it('computes exact totals, versions on revision and wins the opportunity on acceptance', async () => {
    const s = await setup();
    const stages = (await s.owner.get('/pipeline-stages')).body.data;
    const opp = (await s.owner.post('/opportunities', { clientId: s.client.id, name: 'Rollout', value: '5000', currency: 'USD', stageId: stages[2].id }, key())).body.data;
    const quote = (await s.owner.post('/quotes', { clientId: s.client.id, opportunityId: opp.id, title: 'Rollout', items: [{ description: 'Design', quantity: '2.5', unitPrice: '19.99', taxRate: '0.07' }, { description: 'Build', quantity: '1.3333', unitPrice: '75', taxRate: '0.18' }] }, key())).body.data;
    expect(quote).toMatchObject({ number: 'QUO-00001', version: 1, subtotal: '149.98', taxTotal: '21.50', total: '171.48', status: 'DRAFT' });
    expect((await s.owner.post(`/quotes/${quote.id}/accept`)).status).toBe(409);
    await s.owner.post(`/quotes/${quote.id}/send`);
    expect((await s.owner.patch(`/quotes/${quote.id}`, { title: 'x' })).status).toBe(409);
    const v2 = (await s.owner.post(`/quotes/${quote.id}/revise`)).body.data;
    expect(v2).toMatchObject({ number: 'QUO-00001', version: 2, status: 'DRAFT', total: '171.48' });
    expect((await s.owner.get(`/quotes/${quote.id}`)).body.data.status).toBe('SUPERSEDED');
    await s.owner.post(`/quotes/${v2.id}/send`);
    expect((await s.owner.post(`/quotes/${v2.id}/accept`)).body.data.status).toBe('ACCEPTED');
    const won = (await s.owner.get(`/opportunities?clientId=${s.client.id}`)).body.data[0];
    expect(won).toMatchObject({ probability: 100, stage: { isWon: true } });
  });
});

describe('tickets and SLA', () => {
  it('computes SLA in business hours and records first response and breach', async () => {
    const s = await setup();
    const schedule = await prisma.workSchedule.create({ data: { organizationId: s.ctx.org.id, name: 'Support hours', days: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '09:00', end: '17:00' })) } });
    const policies = (await s.owner.get('/sla-policies')).body.data;
    await s.owner.patch(`/sla-policies/${policies[0].id}`, { scheduleId: schedule.id });
    clock.set('2026-10-23T16:00:00Z'); // Friday 16:00
    const owner = await login(app, s.ctx.owner.email);
    const t = (await owner.post('/support-tickets', { subject: 'Login broken', description: 'Users cannot sign in', priority: 'HIGH', clientId: s.client.id, assigneeId: s.agentMember.employeeId }, key())).body.data;
    // HIGH: 4 h first response, 24 h resolution — in business hours.
    expect(t.key).toBe('T-1');
    expect(t.sla.firstResponseDueAt).toBe('2026-10-26T12:00:00.000Z'); // 1 h Fri + 3 h Mon
    expect(t.sla.resolutionDueAt).toBe('2026-10-28T16:00:00.000Z'); // 1 h Fri + 8 Mon + 8 Tue + 7 Wed
    expect(await prisma.notification.count({ where: { organizationId: s.ctx.org.id, recipientUserId: s.agentMember.user.id, type: 'tickets.assigned' } })).toBe(1);

    clock.set('2026-10-26T13:00:00Z');
    expect(await checkSlaBreaches({ prisma, clock, cipher, env })).toEqual({ flagged: 1 });
    const agent = await login(app, s.agentMember.user.email);
    await agent.post(`/support-tickets/${t.id}/comments`, { body: 'Looking now', visibility: 'PUBLIC' });
    const after = (await agent.get(`/support-tickets/${t.id}`)).body.data;
    expect(after.sla).toMatchObject({ firstRespondedAt: '2026-10-26T13:00:00.000Z', firstResponseBreached: true, breached: false });
    expect((await agent.patch(`/support-tickets/${t.id}`, { status: 'RESOLVED' })).body.data.sla.breached).toBe(false);
  });

  it('scopes tickets: assignees see theirs, internal notes need read, public replies need manage', async () => {
    const s = await setup();
    const t = (await s.owner.post('/support-tickets', { subject: 'A', description: 'a', clientId: s.client.id }, key())).body.data;
    const mine = (await s.owner.post('/support-tickets', { subject: 'B', description: 'b', assigneeId: s.agentMember.employeeId }, key())).body.data;
    const agent = await login(app, s.agentMember.user.email);
    expect((await agent.get('/support-tickets')).body.data.map((x) => x.id)).toEqual([mine.id]);
    expect((await agent.get(`/support-tickets/${t.id}`)).status).toBe(404);
    expect((await agent.post(`/support-tickets/${mine.id}/comments`, { body: 'note', visibility: 'INTERNAL' })).status).toBe(201);
  });
});

describe('client portal', () => {
  it('shows a client user only their own client’s shared projects, tickets, public replies and issued invoices', async () => {
    const s = await setup();
    const carla = await portalUser(s, s.client.id, 'carla@globex.test');
    const me = (await carla.get('/auth/me')).body.data;
    expect(me).toMatchObject({ memberType: 'CLIENT', clientId: s.client.id });
    expect((await carla.get('/portal')).body.data.client.name).toBe('Globex Corporation');

    // Projects: only shared ones of their client.
    await s.owner.post('/projects', { name: 'Shared', clientId: s.client.id, sharedWithClient: true }, key());
    await s.owner.post('/projects', { name: 'Internal', clientId: s.client.id }, key());
    await s.owner.post('/projects', { name: 'Initech work', clientId: s.otherClient.id, sharedWithClient: true }, key());
    expect((await carla.get('/portal/projects')).body.data.map((p) => p.name)).toEqual(['Shared']);

    // Tickets: their client only; internal notes never shown.
    const theirs = (await s.owner.post('/support-tickets', { subject: 'Globex issue', description: 'x', clientId: s.client.id }, key())).body.data;
    const other = (await s.owner.post('/support-tickets', { subject: 'Initech issue', description: 'y', clientId: s.otherClient.id }, key())).body.data;
    await s.owner.post(`/support-tickets/${theirs.id}/comments`, { body: 'Internal: customer is on legacy plan', visibility: 'INTERNAL' });
    await s.owner.post(`/support-tickets/${theirs.id}/comments`, { body: 'We are on it', visibility: 'PUBLIC' });
    const list = (await carla.get('/portal/tickets')).body.data;
    expect(list.map((t) => t.subject)).toEqual(['Globex issue']);
    const detail = (await carla.get(`/portal/tickets/${theirs.id}`)).body.data;
    expect(detail.comments.map((c) => c.body)).toEqual(['We are on it']);
    expect(detail).not.toHaveProperty('assignee');
    expect((await carla.get(`/portal/tickets/${other.id}`)).status).toBe(404);
    expect((await carla.post(`/portal/tickets/${other.id}/comments`, { body: 'hi' })).status).toBe(404);

    // Raising a ticket ties it to their client, whatever they send.
    const raised = await carla.post('/portal/tickets', { subject: 'New', description: 'please help' }, key());
    expect(raised.status).toBe(201);
    expect((await prisma.supportTicket.findFirst({ where: { organizationId: s.ctx.org.id, id: raised.body.data.id } })).clientId).toBe(s.client.id);
    await carla.post(`/portal/tickets/${raised.body.data.id}/comments`, { body: 'more detail' });

    // Invoices: issued ones of their client; drafts and other clients never.
    const fin = await login(app, (await createMember(prisma, s.ctx, { role: 'FINANCE_MANAGER' })).user.email);
    const mk = async (clientId, issue) => {
      const d = (await fin.post('/invoices', { clientId, items: [{ description: 'Work', quantity: '1', unitPrice: '100' }] }, key())).body.data;
      return issue ? (await fin.post(`/invoices/${d.id}/issue`, {}, key())).body.data : d;
    };
    const issued = await mk(s.client.id, true);
    const draft = await mk(s.client.id, false);
    const foreign = await mk(s.otherClient.id, true);
    expect((await carla.get('/portal/invoices')).body.data.map((i) => i.id)).toEqual([issued.id]);
    expect((await carla.get(`/portal/invoices/${draft.id}`)).status).toBe(404);
    expect((await carla.get(`/portal/invoices/${foreign.id}`)).status).toBe(404);

    // Internal routes stay closed even though the portal user is a member.
    for (const path of ['/clients', '/invoices', '/support-tickets', '/employees', '/projects', '/calendar?from=2026-10-01&to=2026-10-31', '/roles', '/reports']) {
      expect((await carla.get(path)).status, path).toBe(403);
    }
    expect((await carla.get(`/invoices/${issued.id}`)).status).toBe(403);
    // Staff cannot use the portal as if they were a client.
    expect((await s.owner.get('/portal/tickets')).status).toBe(403);
  });

  it('revoking portal access signs the client user out', async () => {
    const s = await setup();
    const carla = await portalUser(s, s.client.id, 'carla@globex.test');
    const users = (await s.owner.get(`/clients/${s.client.id}/portal-users`)).body.data;
    expect(users).toEqual([expect.objectContaining({ email: 'carla@globex.test', status: 'ACTIVE' })]);
    expect((await s.owner.post(`/clients/${s.client.id}/portal-users/${users[0].id}/revoke`)).status).toBe(204);
    expect((await carla.get('/portal')).status).toBe(401);
  });
});

describe('sales and support reports', () => {
  it('reports lead conversion by source and SLA attainment by priority', async () => {
    const s = await setup();
    for (const [name, source] of [['A', 'Website'], ['B', 'Website'], ['C', 'Referral']]) await s.owner.post('/leads', { name, company: name, source }, key());
    const leads = (await s.owner.get('/leads')).body.data;
    await s.owner.post(`/leads/${leads.find((l) => l.name === 'A').id}/convert`, { createOpportunity: false }, key());
    const conv = (await s.owner.get('/reports/leads?from=2026-10-01&to=2026-10-31')).body.data;
    expect(conv.rows.find((r) => r.label === 'Website')).toMatchObject({ created: 2, converted: 1, conversion: 0.5 });
    expect(conv.totals).toMatchObject({ created: 3, converted: 1 });

    const t1 = (await s.owner.post('/support-tickets', { subject: 'x', description: 'x', priority: 'URGENT' }, key())).body.data;
    await s.owner.post('/support-tickets', { subject: 'y', description: 'y', priority: 'URGENT' }, key());
    await s.owner.patch(`/support-tickets/${t1.id}`, { status: 'RESOLVED' });
    clock.set('2026-10-21T15:00:00Z'); // past the 4 h URGENT resolution target
    const owner = await login(app, s.ctx.owner.email);
    const sla = (await owner.get('/reports/tickets?from=2026-10-01&to=2026-10-31&groupBy=priority')).body.data;
    expect(sla.rows.find((r) => r.label === 'URGENT')).toMatchObject({ created: 2, resolved: 1, withinSla: 1, attainment: 1, open: 1, breachedOpen: 1 });
    const pipeline = (await owner.get('/reports/pipeline?from=2026-10-01&to=2026-10-31&groupBy=stage')).body.data;
    expect(pipeline.rows.map((r) => r.label)).toEqual(['Prospecting', 'Qualification', 'Proposal', 'Negotiation']);
  });
});
