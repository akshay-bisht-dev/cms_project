import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp } from '../helpers/test-app.js';
import { resetDatabase } from '../helpers/db.js';
import { createMember, createOrg, login } from '../helpers/factories.js';

const { app, prisma, clock } = buildTestApp();
afterAll(() => prisma.$disconnect());
beforeEach(async () => {
  clock.set('2026-10-23T12:00:00Z'); // Friday
  await resetDatabase(prisma);
});

let n = 0;
const key = () => ({ 'Idempotency-Key': `ts-test-${Date.now()}-${++n}` });

async function setup() {
  const ctx = await createOrg(prisma);
  await prisma.organization.update({ where: { id: ctx.org.id }, data: { timeZone: 'UTC' } });
  const lead = await createMember(prisma, ctx, { role: 'TEAM_LEAD', name: 'Lead' });
  const dev = await createMember(prisma, ctx, { name: 'Dev', profile: { managerUserId: lead.user.id } });
  const peer = await createMember(prisma, ctx, { name: 'Peer' });
  const team = await prisma.team.create({ data: { organizationId: ctx.org.id, name: 'T', leadUserId: lead.user.id } });
  await prisma.teamMember.createMany({ data: [lead, dev].map((m) => ({ organizationId: ctx.org.id, teamId: team.id, userId: m.user.id })) });
  return { ...ctx, lead, dev, peer, devClient: await login(app, dev.user.email), leadClient: await login(app, lead.user.email) };
}

const entry = (client, start, end, extra = {}) => client.post('/time-entries', { startedAt: start, endedAt: end, description: 'Work', ...extra }, key());

describe('manual time entries', () => {
  it('creates, edits with revisions, and deletes entries; rejects overlaps and future times', async () => {
    const { devClient } = await setup();
    const created = await entry(devClient, '2026-10-20T09:00:00Z', '2026-10-20T11:00:00Z', { isBillable: true });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ durationS: 7200, isBillable: true, locked: false });

    const overlap = await entry(devClient, '2026-10-20T10:30:00Z', '2026-10-20T12:00:00Z');
    expect(overlap.status).toBe(409);
    expect(overlap.body.error.code).toBe('OVERLAP');
    expect((await entry(devClient, '2026-10-23T11:00:00Z', '2026-10-23T13:00:00Z')).status).toBe(400); // future end
    expect((await entry(devClient, '2026-10-20T13:00:00Z', '2026-10-20T12:00:00Z')).status).toBe(400);

    const id = created.body.data.id;
    const edited = await devClient.patch(`/time-entries/${id}`, { endedAt: '2026-10-20T10:00:00Z', reason: 'Left early', version: 0 });
    expect(edited.body.data.durationS).toBe(3600);
    expect((await devClient.patch(`/time-entries/${id}`, { description: 'stale', version: 0 })).body.error.code).toBe('VERSION_CONFLICT');
    const revisions = (await devClient.get(`/time-entries/${id}/revisions`)).body.data;
    expect(revisions.map((r) => [r.revisionNo, r.reason])).toEqual([[1, null], [2, 'Left early']]);

    expect((await devClient.delete(`/time-entries/${id}`, { reason: 'Duplicate' })).status).toBe(204);
    expect((await devClient.get('/time-entries?from=2026-10-20&to=2026-10-20')).body.data).toHaveLength(0);
  });

  it('respects permissions and the organization setting for manual entries', async () => {
    const s = await setup();
    expect((await entry(s.leadClient, '2026-10-20T09:00:00Z', '2026-10-20T10:00:00Z', { employeeId: s.dev.employeeId })).status).toBe(403);
    const owner = await login(app, s.owner.email);
    expect((await entry(owner, '2026-10-20T09:00:00Z', '2026-10-20T10:00:00Z', { employeeId: s.dev.employeeId })).status).toBe(201);
    expect((await s.leadClient.get(`/time-entries?from=2026-10-20&to=2026-10-20&employeeId=${s.dev.employeeId}`)).body.data).toHaveLength(1);
    expect((await s.leadClient.get(`/time-entries?from=2026-10-20&to=2026-10-20&employeeId=${s.peer.employeeId}`)).status).toBe(403);

    await owner.put('/organizations/current/settings/timeTracking', { requireClockInForTimer: true, autoClockInOnTimerStart: true, allowManualEntries: false, timesheetPeriod: 'WEEKLY' });
    expect((await entry(s.devClient, '2026-10-21T09:00:00Z', '2026-10-21T10:00:00Z')).status).toBe(422);
  });
});

describe('timesheet workflow', () => {
  it('collects the week, submits (locking entries), and approves with history', async () => {
    const s = await setup();
    await entry(s.devClient, '2026-10-19T09:00:00Z', '2026-10-19T17:00:00Z', { isBillable: true });
    await entry(s.devClient, '2026-10-20T09:00:00Z', '2026-10-20T13:00:00Z');
    await entry(s.devClient, '2026-10-13T09:00:00Z', '2026-10-13T10:00:00Z'); // previous week

    const sheet = (await s.devClient.post('/timesheets', {})).body.data;
    expect(sheet).toMatchObject({ periodStart: '2026-10-19', periodEnd: '2026-10-25', status: 'DRAFT', totalS: 12 * 3600, billableS: 8 * 3600 });

    const submitted = await s.devClient.post(`/timesheets/${sheet.id}/submit`, undefined, key());
    expect(submitted.body.data.status).toBe('SUBMITTED');
    const [locked] = (await s.devClient.get('/time-entries?from=2026-10-19&to=2026-10-19')).body.data;
    expect(locked.locked).toBe(true);
    const blocked = await s.devClient.patch(`/time-entries/${locked.id}`, { description: 'sneaky edit' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('PERIOD_LOCKED');
    expect((await entry(s.devClient, '2026-10-21T09:00:00Z', '2026-10-21T10:00:00Z')).status).toBe(201); // new entries still allowed

    expect((await s.leadClient.get('/notifications')).body.data[0].type).toBe('timesheets.submitted');
    const queue = (await s.leadClient.get('/timesheets?view=approvals')).body.data;
    expect(queue.map((t) => t.employee.name)).toEqual(['Dev']);
    const detail = (await s.leadClient.get(`/timesheets/${sheet.id}`)).body.data;
    expect(detail.actions).toEqual({ canSubmit: false, canDecide: true, canReopen: false });
    expect(detail.entries).toHaveLength(2);

    expect((await s.devClient.post(`/timesheets/${sheet.id}/approve`, {}, key())).status).toBe(403);
    const approved = await s.leadClient.post(`/timesheets/${sheet.id}/approve`, { comment: 'Thanks' }, key());
    expect(approved.body.data.status).toBe('APPROVED');
    expect((await s.leadClient.post(`/timesheets/${sheet.id}/approve`, {}, key())).status).toBe(409);
    const history = (await s.devClient.get(`/timesheets/${sheet.id}`)).body.data.history;
    expect(history.map((h) => [h.action, h.actor.name, h.comment])).toEqual([
      ['SUBMIT', 'Dev', null],
      ['APPROVE', 'Lead', 'Thanks'],
    ]);
    expect((await s.devClient.get('/notifications')).body.data[0].type).toBe('timesheets.decided');
  });

  it('rejects with a required comment, unlocks entries, and allows resubmission', async () => {
    const s = await setup();
    await entry(s.devClient, '2026-10-19T09:00:00Z', '2026-10-19T17:00:00Z');
    const sheet = (await s.devClient.post('/timesheets', {})).body.data;
    await s.devClient.post(`/timesheets/${sheet.id}/submit`, undefined, key());
    expect((await s.leadClient.post(`/timesheets/${sheet.id}/reject`, {}, key())).status).toBe(400);
    expect((await s.leadClient.post(`/timesheets/${sheet.id}/reject`, { comment: 'Split Monday by task' }, key())).body.data.status).toBe('REJECTED');

    const [unlocked] = (await s.devClient.get('/time-entries?from=2026-10-19&to=2026-10-19')).body.data;
    expect(unlocked.locked).toBe(false);
    await s.devClient.patch(`/time-entries/${unlocked.id}`, { endedAt: '2026-10-19T13:00:00Z' });
    await entry(s.devClient, '2026-10-19T13:00:00Z', '2026-10-19T17:00:00Z', { description: 'Reviews' });
    const resubmitted = await s.devClient.post(`/timesheets/${sheet.id}/submit`, undefined, key());
    expect(resubmitted.body.data).toMatchObject({ status: 'SUBMITTED', totalS: 8 * 3600 });
  });

  it('never counts an entry in two timesheets and keeps the decision history immutable', async () => {
    const s = await setup();
    const owner = await login(app, s.owner.email);
    await entry(s.devClient, '2026-10-20T09:00:00Z', '2026-10-20T17:00:00Z');
    const weekly = (await s.devClient.post('/timesheets', {})).body.data;
    // Switch the organization to daily periods: Tuesday's entry is already counted in the weekly sheet.
    await owner.put('/organizations/current/settings/timeTracking', { requireClockInForTimer: true, autoClockInOnTimerStart: true, allowManualEntries: true, timesheetPeriod: 'DAILY' });
    const devAgain = await login(app, s.dev.user.email);
    const daily = (await devAgain.post('/timesheets', { date: '2026-10-20' })).body.data;
    expect(daily).toMatchObject({ periodStart: '2026-10-20', periodEnd: '2026-10-20' });
    expect(daily.totalS).toBe(0);
    expect(weekly.totalS).toBe(8 * 3600);

    await s.devClient.post(`/timesheets/${weekly.id}/submit`, undefined, key());
    await expect(prisma.$executeRaw`UPDATE timesheet_approvals SET comment = 'forged'`).rejects.toThrow(/append-only/);
  });

  it('refuses to submit an empty period and lets only authorized people reopen', async () => {
    const s = await setup();
    const empty = (await s.devClient.post('/timesheets', {})).body.data;
    expect((await s.devClient.post(`/timesheets/${empty.id}/submit`, undefined, key())).status).toBe(422);

    await entry(s.devClient, '2026-10-19T09:00:00Z', '2026-10-19T10:00:00Z');
    await s.devClient.post(`/timesheets/${empty.id}/submit`, undefined, key());
    await s.leadClient.post(`/timesheets/${empty.id}/approve`, {}, key());
    expect((await s.leadClient.post(`/timesheets/${empty.id}/reopen`, {})).status).toBe(403);
    const owner = await login(app, s.owner.email);
    expect((await owner.post(`/timesheets/${empty.id}/reopen`, { comment: 'Payroll fix' })).body.data.status).toBe('DRAFT');
    const [e] = (await s.devClient.get('/time-entries?from=2026-10-19&to=2026-10-19')).body.data;
    expect(e.locked).toBe(false);
  });

  it('hides other people’s timesheets and exports CSV and PDF', async () => {
    const s = await setup();
    await entry(s.devClient, '2026-10-19T09:00:00Z', '2026-10-19T17:00:00Z', { description: '=cmd|calc' });
    const sheet = (await s.devClient.post('/timesheets', {})).body.data;
    const peer = await login(app, s.peer.user.email);
    expect((await peer.get(`/timesheets/${sheet.id}`)).status).toBe(404);
    expect((await peer.get('/timesheets?view=approvals')).status).toBe(403);

    const csv = await s.devClient.get(`/timesheets/${sheet.id}/export?format=csv`);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text).toContain("'=cmd|calc");
    expect(csv.text).toContain('total_hours,8.00');
    const pdf = await s.leadClient.agent.get(`/api/v1/timesheets/${sheet.id}/export?format=pdf`).buffer(true).parse((res, cb) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');
  });
});

describe('dashboard work metrics', () => {
  it('reports presence, today’s tracked hours and pending approvals', async () => {
    const s = await setup();
    clock.set('2026-10-23T09:00:00Z');
    await s.devClient.post('/time-tracking/start', { description: 'x', isBillable: true }, key());
    clock.set('2026-10-23T10:00:00Z');
    await entry(s.devClient, '2026-10-19T09:00:00Z', '2026-10-19T10:00:00Z');
    const sheet = (await s.devClient.post('/timesheets', { date: '2026-10-19' })).body.data;
    await s.devClient.post(`/timesheets/${sheet.id}/submit`, undefined, key());

    const summary = (await (await login(app, s.lead.user.email)).get('/dashboard/summary')).body.data;
    expect(summary.presence).toEqual({ working: 1, onBreak: 0 });
    expect(summary.today).toMatchObject({ trackedS: 3600, billableS: 3600, nonBillableS: 0 });
    expect(summary.pendingTimesheets).toBe(1);
    expect(summary.pendingCorrections).toBe(0);
    const employee = (await s.devClient.get('/dashboard/summary')).body.data;
    expect(employee.pendingTimesheets).toBeNull();
  });
});
