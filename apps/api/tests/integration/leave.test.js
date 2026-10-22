import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp } from '../helpers/test-app.js';
import { resetDatabase } from '../helpers/db.js';
import { createMember, createOrg, login } from '../helpers/factories.js';
import { runAccruals, runCarryOver } from '../../src/modules/leave/jobs.js';
import { markAbsences } from '../../src/modules/attendance/jobs.js';

const { app, prisma, clock } = buildTestApp();
afterAll(() => prisma.$disconnect());
beforeEach(async () => {
  clock.set('2026-10-21T09:00:00Z'); // Wednesday
  await resetDatabase(prisma);
});

let n = 0;
const key = () => ({ 'Idempotency-Key': `leave-test-${Date.now()}-${++n}` });

async function setup() {
  const ctx = await createOrg(prisma);
  await prisma.workSchedule.create({ data: { organizationId: ctx.org.id, name: 'Office', isDefault: true, days: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '09:00', end: '17:00' })) } });
  const hr = await createMember(prisma, ctx, { role: 'HR_MANAGER', name: 'Hana HR' });
  const manager = await createMember(prisma, ctx, { role: 'TEAM_LEAD', name: 'Max Manager' });
  const emp = await createMember(prisma, ctx, { name: 'Esha Employee', profile: { managerUserId: manager.user.id } });
  await prisma.organizationMember.updateMany({ where: { organizationId: ctx.org.id }, data: { joinedAt: new Date('2025-01-01T00:00:00Z') } });
  const [owner, hrC, mgrC, empC] = await Promise.all([ctx.owner.email, hr.user.email, manager.user.email, emp.user.email].map((e) => login(app, e)));
  await runAccruals({ prisma, clock }); // annual: 20 annual, 10 sick
  const types = Object.fromEntries((await empC.get('/leave/types')).body.data.map((t) => [t.code, t]));
  return { ctx, hr, manager, emp, owner, hrC, mgrC, empC, types };
}

const ask = (client, types, body) => client.post('/leave/requests', { leaveTypeId: types.ANNUAL.id, ...body }, key());

describe('balances', () => {
  it('accrues from the ledger idempotently, caps and carries over', async () => {
    const s = await setup();
    const balances = (await s.empC.get('/leave/balances')).body.data;
    expect(balances.find((b) => b.leaveType.code === 'ANNUAL')).toMatchObject({ balance: 20, used: 0, pending: 0, available: 20 });
    expect(balances.find((b) => b.leaveType.code === 'SICK')).toMatchObject({ balance: 10 });
    await runAccruals({ prisma, clock });
    await runAccruals({ prisma, clock });
    expect((await s.empC.get('/leave/balances')).body.data.find((b) => b.leaveType.code === 'ANNUAL').balance).toBe(20);

    // Monthly policy with a cap.
    const policy = (await s.hrC.post('/leave/policies', { leaveTypeId: s.types.SICK.id, name: 'Monthly sick', accrual: 'MONTHLY', accrualDays: '1.5', capDays: '11', approvalChain: ['MANAGER'] })).body.data;
    await s.hrC.put(`/leave/policies/${policy.id}/assignments`, { targets: [{ type: 'MEMBER', id: s.emp.employeeId }] });
    await runAccruals({ prisma, clock });
    expect((await s.empC.get('/leave/balances')).body.data.find((b) => b.leaveType.code === 'SICK').balance).toBe(11); // 10 + 1 (capped)

    // Year end: 20 unused, carry over at most 5.
    clock.set('2027-01-02T09:00:00Z');
    await runCarryOver({ prisma, clock });
    await runCarryOver({ prisma, clock });
    await runAccruals({ prisma, clock });
    const emp = await login(app, s.emp.user.email);
    const next = (await emp.get('/leave/balances?year=2027')).body.data.find((b) => b.leaveType.code === 'ANNUAL');
    expect(next.balance).toBe(25);
    const ledger = (await emp.get(`/leave/ledger?leaveTypeId=${s.types.ANNUAL.id}&year=2027`)).body.data;
    expect(ledger.map((l) => [l.entryType, l.days])).toEqual([['CARRY_OVER', 5], ['ACCRUAL', 20]]);
    await expect(prisma.$executeRaw`UPDATE leave_ledger_entries SET days = 99`).rejects.toThrow(/append-only/);
  });

  it('refuses requests beyond the available balance unless the policy allows negative', async () => {
    const s = await setup();
    const tooMuch = await ask(s.empC, s.types, { startDate: '2026-11-02', endDate: '2026-11-30' }); // 21 working days
    expect(tooMuch.status).toBe(422);
    expect(tooMuch.body.error.code).toBe('INSUFFICIENT_BALANCE');
    // Pending requests hold days: 15 pending leaves 5.
    expect((await ask(s.empC, s.types, { startDate: '2026-11-02', endDate: '2026-11-20' })).status).toBe(201);
    const bal = (await s.empC.get('/leave/balances')).body.data.find((b) => b.leaveType.code === 'ANNUAL');
    expect(bal).toMatchObject({ balance: 20, pending: 15, available: 5 });
    expect((await ask(s.empC, s.types, { startDate: '2026-12-01', endDate: '2026-12-08' })).status).toBe(422); // 6 days
    const unpaid = await s.empC.post('/leave/requests', { leaveTypeId: s.types.UNPAID.id, startDate: '2026-12-01', endDate: '2026-12-31' }, key());
    expect(unpaid.status).toBe(201);
  });
});

describe('requests', () => {
  it('counts working days only, with half days', async () => {
    const s = await setup();
    await s.owner.post('/attendance/holidays', { date: '2026-11-04', name: 'Festival' });
    const preview = (await s.empC.post('/leave/requests/preview', { leaveTypeId: s.types.ANNUAL.id, startDate: '2026-11-02', endDate: '2026-11-09', startHalf: 'PM' })).body.data;
    expect(preview).toMatchObject({ days: 4.5, available: 20, afterRequest: 15.5 }); // ½ Mon + Tue + Thu + Fri + Mon (holiday Wed, weekend)
    expect((await ask(s.empC, s.types, { startDate: '2026-11-07', endDate: '2026-11-08' })).status).toBe(422); // weekend only
  });

  it('falls back to a Monday–Friday week when no schedule exists', async () => {
    const s = await setup();
    await prisma.workSchedule.updateMany({ where: { organizationId: s.ctx.org.id }, data: { archivedAt: new Date() } });
    const preview = (await s.empC.post('/leave/requests/preview', { leaveTypeId: s.types.ANNUAL.id, startDate: '2026-11-04', endDate: '2026-11-09' })).body.data;
    expect(preview.days).toBe(4); // Wed, Thu, Fri, Mon
  });

  it('rejects overlapping leave at half-day precision, even when requested concurrently', async () => {
    const s = await setup();
    expect((await ask(s.empC, s.types, { startDate: '2026-11-02', endDate: '2026-11-02', startHalf: 'AM' })).status).toBe(201);
    expect((await ask(s.empC, s.types, { startDate: '2026-11-02', endDate: '2026-11-02', startHalf: 'PM' })).status).toBe(201); // the other half
    const overlap = await ask(s.empC, s.types, { startDate: '2026-10-30', endDate: '2026-11-02' });
    expect(overlap.status).toBe(409);
    expect(overlap.body.error.code).toBe('OVERLAP');
    const results = await Promise.all([...Array(5)].map(() => ask(s.empC, s.types, { startDate: '2026-11-16', endDate: '2026-11-18' })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
  });

  it('walks the approval chain, books the leave and returns it on cancellation', async () => {
    const s = await setup();
    const req = (await ask(s.empC, s.types, { startDate: '2026-11-02', endDate: '2026-11-06', reason: 'Family trip' })).body.data;
    expect(req).toMatchObject({ days: 5, status: 'PENDING', step: { index: 0, of: 2, rule: 'MANAGER', approvers: [{ name: 'Max Manager' }] } });
    expect(await prisma.notification.count({ where: { organizationId: s.ctx.org.id, recipientUserId: s.manager.user.id, type: 'leave.requested' } })).toBe(1);
    expect((await s.empC.post(`/leave/requests/${req.id}/approve`, {}, key())).status).toBe(403); // not their own
    expect((await s.mgrC.post(`/leave/requests/${req.id}/reject`, {}, key())).status).toBe(400); // comment required

    const step1 = (await s.mgrC.post(`/leave/requests/${req.id}/approve`, { comment: 'Fine by me' }, key())).body.data;
    expect(step1).toMatchObject({ status: 'PENDING', step: { index: 1, rule: 'HR' } });
    expect((await s.mgrC.post(`/leave/requests/${req.id}/approve`, {}, key())).status).toBe(403); // not an HR approver
    const done = (await s.hrC.post(`/leave/requests/${req.id}/approve`, {}, key())).body.data;
    expect(done.status).toBe('APPROVED');
    expect(done.history.map((h) => h.action)).toEqual(['APPROVE', 'APPROVE']);
    expect((await s.empC.get('/leave/balances')).body.data.find((b) => b.leaveType.code === 'ANNUAL')).toMatchObject({ balance: 15, used: 5, available: 15 });

    // Approved leave is not an absence, and shows on the calendar.
    await markAbsences({ prisma, organizationId: s.ctx.org.id, date: '2026-11-03' });
    expect((await prisma.attendanceRecord.findFirst({ where: { organizationId: s.ctx.org.id, userId: s.emp.user.id } })).status).toBe('LEAVE');
    const cal = (await s.empC.get('/calendar?from=2026-11-01&to=2026-11-30&sources=leave')).body.data;
    expect(cal.items ?? cal).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'leave', start: '2026-11-02', end: '2026-11-06' })]));

    const cancelled = (await s.empC.post(`/leave/requests/${req.id}/cancel`, {}, key())).body.data;
    expect(cancelled.status).toBe('CANCELLED');
    expect((await s.empC.get('/leave/balances')).body.data.find((b) => b.leaveType.code === 'ANNUAL')).toMatchObject({ balance: 20, used: 5 });
    const ledger = (await s.empC.get(`/leave/ledger?leaveTypeId=${s.types.ANNUAL.id}`)).body.data;
    expect(ledger.map((l) => l.entryType)).toEqual(['ACCRUAL', 'USAGE', 'REVERSAL']);
  });

  it('only HR can cancel leave that has started; adjustments are ledger entries', async () => {
    const s = await setup();
    const req = (await ask(s.empC, s.types, { startDate: '2026-10-21', endDate: '2026-10-22' })).body.data;
    await s.mgrC.post(`/leave/requests/${req.id}/approve`, {}, key());
    await s.hrC.post(`/leave/requests/${req.id}/approve`, {}, key());
    expect((await s.empC.post(`/leave/requests/${req.id}/cancel`, {}, key())).status).toBe(422);
    expect((await s.hrC.post(`/leave/requests/${req.id}/cancel`, { comment: 'Came back early' }, key())).body.data.status).toBe('CANCELLED');

    const adj = await s.hrC.post('/leave/balances/adjust', { employeeId: s.emp.employeeId, leaveTypeId: s.types.ANNUAL.id, days: '-2.5', note: 'Unrecorded leave in March' }, key());
    expect(adj.body.data.find((b) => b.leaveType.code === 'ANNUAL').balance).toBe(17.5);
    expect((await s.empC.post('/leave/balances/adjust', { employeeId: s.emp.employeeId, leaveTypeId: s.types.ANNUAL.id, days: '5', note: 'x' }, key())).status).toBe(403);
    const hrSelf = await s.hrC.post('/leave/balances/adjust', { employeeId: s.hr.employeeId, leaveTypeId: s.types.ANNUAL.id, days: '5', note: 'x' }, key());
    expect(hrSelf.status).toBe(403);
  });

  it('scopes visibility: peers cannot see each other’s leave; leads see their team', async () => {
    const s = await setup();
    const peer = await createMember(prisma, s.ctx, { name: 'Pat Peer' });
    const peerC = await login(app, peer.user.email);
    const req = (await ask(s.empC, s.types, { startDate: '2026-11-02', endDate: '2026-11-03' })).body.data;
    expect((await peerC.get(`/leave/requests/${req.id}`)).status).toBe(404);
    expect((await peerC.get(`/leave/balances?employeeId=${s.emp.employeeId}`)).status).toBe(403);
    expect((await s.mgrC.get('/leave/requests?view=approvals')).body.data.map((r) => r.id)).toEqual([req.id]);
    expect((await peerC.get('/leave/requests?view=approvals')).status).toBe(403);
  });
});
