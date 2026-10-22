import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp } from '../helpers/test-app.js';
import { resetDatabase } from '../helpers/db.js';
import { createMember, createOrg, login } from '../helpers/factories.js';

const { app, prisma, clock } = buildTestApp();
afterAll(() => prisma.$disconnect());
beforeEach(async () => {
  clock.set('2026-10-21T09:00:00Z');
  await resetDatabase(prisma);
});

let n = 0;
const key = () => ({ 'Idempotency-Key': `finance-test-${Date.now()}-${++n}` });

async function setup() {
  const ctx = await createOrg(prisma);
  const finance = await createMember(prisma, ctx, { role: 'FINANCE_MANAGER', name: 'Fiona Finance' });
  const dev = await createMember(prisma, ctx, { name: 'Dev One' });
  const dev2 = await createMember(prisma, ctx, { name: 'Dev Two' });
  const pm = await createMember(prisma, ctx, { role: 'PROJECT_MANAGER', name: 'Pam PM' });
  const owner = await login(app, ctx.owner.email);
  const client = (await owner.post('/clients', { name: 'Globex Corporation', defaultCurrency: 'USD', status: 'ACTIVE', paymentTermsDays: 15 }, key())).body.data;
  const project = (await owner.post('/projects', { name: 'Portal Build', clientId: client.id, managerEmployeeId: pm.employeeId, memberEmployeeIds: [dev.employeeId, dev2.employeeId] }, key())).body.data;
  return { ctx, finance, dev, dev2, pm, owner, client, project, fin: await login(app, finance.user.email) };
}

/** Billable time in an APPROVED timesheet (what invoicing may bill). */
async function approvedTime(s, member, entries, status = 'APPROVED') {
  const sheet = await prisma.timesheet.create({ data: { organizationId: s.ctx.org.id, userId: member.user.id, periodStart: new Date('2026-10-12T00:00:00Z'), periodEnd: new Date('2026-10-18T00:00:00Z'), status } });
  const ids = [];
  for (const [start, end, billable = true] of entries) {
    const e = await prisma.timeEntry.create({
      data: { organizationId: s.ctx.org.id, userId: member.user.id, projectId: s.project.id, startedAt: new Date(start), endedAt: new Date(end), durationS: (Date.parse(end) - Date.parse(start)) / 1000, isBillable: billable, source: 'MANUAL' },
    });
    await prisma.timesheetEntry.create({ data: { organizationId: s.ctx.org.id, timesheetId: sheet.id, timeEntryId: e.id } });
    ids.push(e.id);
  }
  return ids;
}

describe('rates', () => {
  it('resolves billing precedence and refuses overlapping periods', async () => {
    const s = await setup();
    const rate = (body) => s.fin.post('/billing-rates', { kind: 'BILL', currency: 'USD', effectiveFrom: '2026-01-01', ...body });
    expect((await rate({ targetType: 'ORG', amount: '100' })).status).toBe(201);
    expect((await rate({ targetType: 'MEMBER', targetId: s.dev.employeeId, amount: '120' })).status).toBe(201);
    expect((await rate({ targetType: 'PROJECT_MEMBER', targetId: s.dev.employeeId, projectId: s.project.id, amount: '150.50' })).status).toBe(201);
    const overlap = await rate({ targetType: 'ORG', amount: '90', effectiveFrom: '2026-06-01' });
    expect(overlap.status).toBe(409);
    expect(overlap.body.error.code).toBe('OVERLAP');

    await approvedTime(s, s.dev, [['2026-10-13T09:00:00Z', '2026-10-13T11:00:00Z']]);
    await approvedTime(s, s.dev2, [['2026-10-13T09:00:00Z', '2026-10-13T10:30:00Z']]);
    const preview = (await s.fin.get(`/invoices/billable-time?clientId=${s.client.id}&from=2026-10-01&to=2026-10-31`)).body.data;
    expect(preview.lines.map((l) => [l.employee.name, l.hours, l.rate, l.lineTotal]).sort()).toEqual([
      ['Dev One', '2.0000', '150.50', '301.00'], // project-member rate wins
      ['Dev Two', '1.5000', '100.00', '150.00'], // falls back to the organization rate
    ]);
  });

  it('keeps cost rates away from people without finance.cost.read', async () => {
    const s = await setup();
    const pm = await login(app, s.pm.user.email);
    expect((await pm.get('/billing-rates')).status).toBe(403);
    expect((await s.fin.post('/billing-rates', { kind: 'COST', targetType: 'MEMBER', targetId: s.dev.employeeId, amount: '40', currency: 'USD', effectiveFrom: '2026-01-01' })).status).toBe(201);
    expect((await s.fin.get('/billing-rates?kind=COST')).body.data).toHaveLength(1);
  });
});

describe('invoices from time', () => {
  async function draftWithTime(s, from = '2026-10-01', to = '2026-10-31') {
    const draft = (await s.fin.post('/invoices', { clientId: s.client.id, notes: 'October' }, key())).body.data;
    const res = await s.fin.post(`/invoices/${draft.id}/time`, { from, to, taxRate: '0.18' }, key());
    return { draft, res };
  }

  it('bills only approved billable time, with exact decimal totals', async () => {
    const s = await setup();
    await s.fin.post('/billing-rates', { kind: 'BILL', targetType: 'ORG', amount: '75', currency: 'USD', effectiveFrom: '2026-01-01' });
    // 1 h 20 min = 1.3333 h → 99.9975 → 100.00 (half-even at cents); 18 % tax = 18.00.
    await approvedTime(s, s.dev, [['2026-10-13T09:00:00Z', '2026-10-13T10:20:00Z'], ['2026-10-14T09:00:00Z', '2026-10-14T10:00:00Z', false]]);
    await approvedTime(s, s.dev2, [['2026-10-13T09:00:00Z', '2026-10-13T12:00:00Z']], 'SUBMITTED'); // not approved yet
    const { res } = await draftWithTime(s);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0]).toMatchObject({ kind: 'TIME', quantity: '1.3333', unitPrice: '75.0000', lineTotal: '100.00', taxAmount: '18.00' });
    expect(res.body.data).toMatchObject({ subtotal: '100.00', taxTotal: '18.00', total: '118.00', status: 'DRAFT', number: null });
  });

  it('never bills the same time twice, even when two drafts race', async () => {
    const s = await setup();
    await s.fin.post('/billing-rates', { kind: 'BILL', targetType: 'ORG', amount: '100', currency: 'USD', effectiveFrom: '2026-01-01' });
    await approvedTime(s, s.dev, [['2026-10-13T09:00:00Z', '2026-10-13T11:00:00Z']]);
    const a = (await s.fin.post('/invoices', { clientId: s.client.id }, key())).body.data;
    const b = (await s.fin.post('/invoices', { clientId: s.client.id }, key())).body.data;
    const results = await Promise.all([a, b].map((inv) => s.fin.post(`/invoices/${inv.id}/time`, { from: '2026-10-01', to: '2026-10-31' }, key())));
    expect(results.map((r) => r.status).sort()).toEqual([200, expect.any(Number)].sort());
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.find((r) => r.status !== 200).status).toBeOneOf([409, 422]);
    expect(await prisma.invoiceItemTimeEntry.count({ where: { organizationId: s.ctx.org.id } })).toBe(1);
    // The database itself refuses a second link.
    const entry = await prisma.timeEntry.findFirst({ where: { organizationId: s.ctx.org.id } });
    const item = await prisma.invoiceItem.findFirst({ where: { organizationId: s.ctx.org.id } });
    await expect(prisma.invoiceItemTimeEntry.create({ data: { organizationId: s.ctx.org.id, invoiceItemId: item.id, timeEntryId: entry.id } })).rejects.toThrow();
  });

  it('frees time again when a line is removed, a draft deleted or an invoice voided', async () => {
    const s = await setup();
    await s.fin.post('/billing-rates', { kind: 'BILL', targetType: 'ORG', amount: '100', currency: 'USD', effectiveFrom: '2026-01-01' });
    await approvedTime(s, s.dev, [['2026-10-13T09:00:00Z', '2026-10-13T11:00:00Z']]);
    const { draft, res } = await draftWithTime(s);
    await s.fin.delete(`/invoices/${draft.id}/items/${res.body.data.items[0].id}`);
    const again = await draftWithTime(s);
    expect(again.res.status).toBe(200);
    const issued = await s.fin.post(`/invoices/${again.draft.id}/issue`, {}, key());
    expect(issued.body.data).toMatchObject({ status: 'ISSUED', number: 'INV-00001', issueDate: '2026-10-21', dueDate: '2026-11-05' });
    expect((await s.fin.post(`/invoices/${again.draft.id}/void`, { reason: 'Wrong client' })).body.data.status).toBe('VOID');
    const third = await draftWithTime(s);
    expect(third.res.status).toBe(200);
  });

  it('numbers invoices sequentially without gaps', async () => {
    const s = await setup();
    const numbers = [];
    for (let i = 0; i < 3; i += 1) {
      const d = (await s.fin.post('/invoices', { clientId: s.client.id, items: [{ description: 'Retainer', quantity: '1', unitPrice: '500' }] }, key())).body.data;
      numbers.push((await s.fin.post(`/invoices/${d.id}/issue`, {}, key())).body.data.number);
    }
    expect(numbers).toEqual(['INV-00001', 'INV-00002', 'INV-00003']);
  });
});

describe('payments', () => {
  async function issued(s, amount = '1000.00') {
    const d = (await s.fin.post('/invoices', { clientId: s.client.id, items: [{ description: 'Discovery', quantity: '1', unitPrice: amount }] }, key())).body.data;
    return (await s.fin.post(`/invoices/${d.id}/issue`, {}, key())).body.data;
  }
  const pay = (s, id, amount) => s.fin.post(`/invoices/${id}/payments`, { amount, receivedOn: '2026-10-22', method: 'BANK_TRANSFER', reference: 'TX' }, key());

  it('derives PARTIALLY_PAID and PAID from the payment ledger only', async () => {
    const s = await setup();
    const inv = await issued(s);
    expect((await pay(s, inv.id, '400.00')).body.data).toMatchObject({ status: 'PARTIALLY_PAID', amountPaid: '400.00', outstanding: '600.00' });
    const over = await pay(s, inv.id, '600.01');
    expect(over.status).toBe(422);
    expect((await pay(s, inv.id, '600.00')).body.data).toMatchObject({ status: 'PAID', outstanding: '0.00' });
    // A refund reopens it.
    expect((await pay(s, inv.id, '-100.00')).body.data).toMatchObject({ status: 'PARTIALLY_PAID', amountPaid: '900.00' });
    expect((await s.fin.post(`/invoices/${inv.id}/void`, { reason: 'x' })).status).toBe(422);
  });

  it('cannot become PAID without payments, even by writing to the database', async () => {
    const s = await setup();
    const inv = await issued(s);
    // No API sets a status directly…
    expect((await s.fin.patch(`/invoices/${inv.id}`, { status: 'PAID' })).status).toBe(400);
    // …and the database rejects it too (CHECK constraint).
    await expect(prisma.$executeRaw`UPDATE invoices SET status = 'PAID' WHERE id = ${inv.id}`).rejects.toThrow(/invoices_paid_requires_payments|3819|check/i);
    await expect(prisma.$executeRaw`UPDATE payment_records SET amount = 1`).resolves.toBe(0); // no rows yet
    await pay(s, inv.id, '10.00');
    await expect(prisma.$executeRaw`UPDATE payment_records SET amount = 999`).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRaw`DELETE FROM payment_records`).rejects.toThrow(/append-only/);
  });

  it('serializes concurrent payments so the total is never exceeded', async () => {
    const s = await setup();
    const inv = await issued(s, '100.00');
    const results = await Promise.all([...Array(5)].map(() => pay(s, inv.id, '40.00')));
    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    const final = (await s.fin.get(`/invoices/${inv.id}`)).body.data;
    expect(final).toMatchObject({ amountPaid: '80.00', status: 'PARTIALLY_PAID' });
    expect(final.payments).toHaveLength(2);
  });

  it('marks unpaid invoices past their due date as overdue and renders a PDF', async () => {
    const s = await setup();
    const inv = await issued(s);
    clock.set('2026-11-10T09:00:00Z');
    const fin = await login(app, s.finance.user.email);
    expect((await fin.get('/invoices?overdue=true')).body.data.map((i) => i.id)).toEqual([inv.id]);
    const pdf = await fin.agent.get(`/api/v1/invoices/${inv.id}/pdf`).buffer(true).parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.body.subarray(0, 4).toString()).toBe('%PDF');
  });
});

describe('expenses', () => {
  it('runs submit → approve → bill, never by the submitter, never twice', async () => {
    const s = await setup();
    const dev = await login(app, s.dev.user.email);
    const pm = await login(app, s.pm.user.email);
    const created = await dev.post('/expenses', { description: 'Client lunch', amount: '84.50', currency: 'USD', incurredOn: '2026-10-15', isBillable: true, projectId: s.project.id });
    expect(created.body.data).toMatchObject({ status: 'DRAFT', client: { id: s.client.id } });
    const id = created.body.data.id;
    expect((await dev.post(`/expenses/${id}/submit`)).body.data.status).toBe('SUBMITTED');
    expect((await dev.post(`/expenses/${id}/decide`, { decision: 'APPROVED' })).status).toBe(403);
    const approvals = (await pm.get('/expenses?view=approvals')).body.data;
    expect(approvals.map((e) => e.id)).toEqual([id]); // the PM manages the project
    expect((await pm.post(`/expenses/${id}/decide`, { decision: 'REJECTED' })).status).toBe(400);
    expect((await pm.post(`/expenses/${id}/decide`, { decision: 'APPROVED' })).body.data.status).toBe('APPROVED');
    expect(await prisma.notification.count({ where: { organizationId: s.ctx.org.id, recipientUserId: s.dev.user.id, type: 'expenses.decided' } })).toBe(1);

    const draft = (await s.fin.post('/invoices', { clientId: s.client.id }, key())).body.data;
    expect((await s.fin.get(`/invoices/${draft.id}/billable-expenses`)).body.data.map((e) => e.id)).toEqual([id]);
    const withExpense = await s.fin.post(`/invoices/${draft.id}/expenses`, { expenseIds: [id] }, key());
    expect(withExpense.body.data).toMatchObject({ total: '84.50' });
    const other = (await s.fin.post('/invoices', { clientId: s.client.id }, key())).body.data;
    expect((await s.fin.post(`/invoices/${other.id}/expenses`, { expenseIds: [id] }, key())).status).toBe(409);
  });
});

describe('cross-organization isolation', () => {
  it('hides another organization’s invoices, clients and expenses', async () => {
    const s = await setup();
    const inv = (await s.fin.post('/invoices', { clientId: s.client.id, items: [{ description: 'x', quantity: '1', unitPrice: '1' }] }, key())).body.data;
    const other = await createOrg(prisma);
    const outsider = await login(app, other.owner.email);
    expect((await outsider.get(`/invoices/${inv.id}`)).status).toBe(404);
    expect((await outsider.get(`/clients/${s.client.id}`)).status).toBe(404);
    expect((await outsider.post('/invoices', { clientId: s.client.id }, key())).status).toBe(400);
    expect((await outsider.get('/invoices')).body.data).toHaveLength(0);
  });
});

describe('finance reports', () => {
  it('reports revenue, collections, receivables and project margins in the base currency', async () => {
    const s = await setup();
    await s.fin.post('/billing-rates', { kind: 'BILL', targetType: 'ORG', amount: '100', currency: 'USD', effectiveFrom: '2026-01-01' });
    await s.fin.post('/billing-rates', { kind: 'COST', targetType: 'ORG', amount: '40', currency: 'USD', effectiveFrom: '2026-01-01' });
    await approvedTime(s, s.dev, [['2026-10-13T09:00:00Z', '2026-10-13T19:00:00Z']]); // 10 h
    const draft = (await s.fin.post('/invoices', { clientId: s.client.id, projectId: s.project.id }, key())).body.data;
    await s.fin.post(`/invoices/${draft.id}/time`, { from: '2026-10-01', to: '2026-10-31' }, key());
    await s.fin.post(`/invoices/${draft.id}/issue`, { issueDate: '2026-10-15', dueDate: '2026-10-20' }, key());
    await s.fin.post(`/invoices/${draft.id}/payments`, { amount: '250.00', receivedOn: '2026-10-18', method: 'CARD' }, key());

    const revenue = (await s.fin.get('/reports/revenue?from=2026-10-01&to=2026-10-31&groupBy=client')).body.data;
    expect(revenue.rows).toEqual([{ label: 'Globex Corporation', invoiced: '1000.00', collected: '250.00', outstanding: '750.00', overdue: '750.00' }]);
    expect(revenue.columns.find((c) => c.key === 'invoiced')).toMatchObject({ kind: 'measured', type: 'money' });

    const margins = (await s.fin.get('/reports/margins?from=2026-10-01&to=2026-10-31')).body.data;
    expect(margins.rows[0]).toMatchObject({ revenue: '1000.00', cost: '400.00', profit: '600.00', margin: 0.6 });

    const pm = await login(app, s.pm.user.email);
    expect((await pm.get('/reports/margins?from=2026-10-01&to=2026-10-31')).status).toBe(403); // no cost access
  });
});
