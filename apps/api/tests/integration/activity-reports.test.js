import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp } from '../helpers/test-app.js';
import { resetDatabase } from '../helpers/db.js';
import { createMember, createOrg, login } from '../helpers/factories.js';
import { runReportJob, expireReportJobs } from '../../src/modules/reports/reports.service.js';
import { ensureStats } from '../../src/modules/activity/stats.js';
import { processDirtyStats } from '../../src/modules/activity/rollup.js';

const { app, prisma, clock, storage } = buildTestApp();
afterAll(() => prisma.$disconnect());
beforeEach(async () => {
  clock.set('2026-10-21T08:00:00Z'); // a Wednesday
  storage.objects.clear();
  await resetDatabase(prisma);
});

const H = 3600;
let n = 0;
const key = () => ({ 'Idempotency-Key': `activity-test-${Date.now()}-${++n}` });
const at = (hhmm, day = '2026-10-21') => clock.set(`${day}T${hhmm}:00Z`);

async function setup() {
  const ctx = await createOrg(prisma);
  await prisma.workSchedule.create({
    data: { organizationId: ctx.org.id, name: 'Office', isDefault: true, days: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '09:00', end: '17:00' })) },
  });
  const emp = await createMember(prisma, ctx, { name: 'Esha Employee' });
  const peer = await createMember(prisma, ctx, { name: 'Pat Peer' });
  const hr = await createMember(prisma, ctx, { role: 'HR_MANAGER', name: 'Hana HR' });
  const lead = await createMember(prisma, ctx, { role: 'TEAM_LEAD', name: 'Leo Lead' });
  const team = await prisma.team.create({ data: { organizationId: ctx.org.id, name: 'Platform', leadUserId: lead.user.id } });
  await prisma.teamMember.createMany({ data: [emp, lead].map((m) => ({ organizationId: ctx.org.id, teamId: team.id, userId: m.user.id })) });
  // Members joined well before the (fixed) test clock, so earlier days count as scheduled.
  await prisma.organizationMember.updateMany({ where: { organizationId: ctx.org.id }, data: { joinedAt: new Date('2026-01-01T00:00:00Z') } });
  return { ctx, emp, peer, hr, lead, team };
}

const clients = async (s) => ({
  owner: await login(app, s.ctx.owner.email),
  employee: await login(app, s.emp.user.email),
  peer: await login(app, s.peer.user.email),
  hr: await login(app, s.hr.user.email),
  lead: await login(app, s.lead.user.email),
});

/** 09:00 in with a billable timer, 12:00–12:30 break (pauses the timer), resume, 17:30 out. */
async function workDay(client, day = '2026-10-21', { late = false } = {}) {
  at(late ? '09:40' : '09:00', day);
  expect((await client.post('/attendance/clock-in', {}, key())).status).toBe(201);
  expect((await client.post('/time-tracking/start', { description: 'Build', isBillable: true }, key())).status).toBeLessThan(300);
  at('12:00', day);
  await client.post('/attendance/break/start', undefined, key());
  at('12:30', day);
  await client.post('/attendance/break/end', undefined, key());
  await client.post('/time-tracking/resume', undefined, key());
  at('17:30', day);
  expect((await client.post('/attendance/clock-out', undefined, key())).status).toBe(200);
}

describe('activity events', () => {
  it('records every transition append-only and builds the day from them', async () => {
    const s = await setup();
    const { employee } = await clients(s);
    await workDay(employee);
    const types = (await prisma.activityEvent.findMany({ where: { organizationId: s.ctx.org.id, userId: s.emp.user.id }, orderBy: { occurredAt: 'asc' } })).map((e) => e.type);
    expect(types).toEqual(['attendance.clock_in', 'timer.started', 'attendance.break_start', 'attendance.break_end', 'timer.resumed', 'attendance.clock_out']);
    await expect(prisma.$executeRaw`UPDATE activity_events SET type = 'x'`).rejects.toThrow(/append-only/);

    const day = (await employee.get('/activity/day?date=2026-10-21')).body.data;
    expect(day.stats).toMatchObject({ status: 'PRESENT', scheduledS: 8 * H, workedS: 8 * H, breakS: 0.5 * H, trackedS: 8 * H, billableS: 8 * H, lateByS: 0 });
    expect(day.events.map((e) => e.type)).toContain('timer.resumed');
    expect(day.timeEntries).toHaveLength(2);
  });

  it('keeps stats current after an edit to an earlier day (dirty-day rebuild)', async () => {
    const s = await setup();
    const { employee } = await clients(s);
    await workDay(employee, '2026-10-20');
    at('10:00', '2026-10-21');
    expect((await employee.get('/activity/day?date=2026-10-20')).body.data.stats.trackedS).toBe(8 * H);
    const add = await employee.post('/time-entries', { startedAt: '2026-10-20T18:00:00Z', endedAt: '2026-10-20T19:00:00Z', description: 'Docs' }, key());
    expect(add.status).toBe(201);
    expect(await prisma.statsDirtyDay.count({ where: { organizationId: s.ctx.org.id } })).toBeGreaterThan(0);
    const week = (await employee.get('/activity/week?weekStart=2026-10-19')).body.data;
    expect(week.days.find((d) => d.date === '2026-10-20')).toMatchObject({ trackedS: 9 * H, billableS: 8 * H });
    expect(week.summary).toMatchObject({ trackedS: 9 * H, presentDays: 1, absentDays: 1 }); // Monday was scheduled and missed
    expect(week.days.find((d) => d.date === '2026-10-23')).toMatchObject({ status: 'NONE', future: true });
  });

  it('scopes activity: self, team lead, org-wide HR — and hides monitoring from those without it', async () => {
    const s = await setup();
    const c = await clients(s);
    await workDay(c.employee);
    const q = `/activity/day?date=2026-10-21&employeeId=${s.emp.employeeId}`;
    expect((await c.peer.get(q)).status).toBe(403);
    expect((await c.lead.get(q)).status).toBe(200);
    const hrView = (await c.hr.get(q)).body.data;
    expect(hrView.includesMonitoring).toBe(false);
    expect(hrView.stats).not.toHaveProperty('screenshotsOk');
    const ownerView = (await c.owner.get(q)).body.data;
    expect(ownerView.stats).toHaveProperty('screenshotsOk');
    const team = (await c.lead.get('/activity/team?date=2026-10-21')).body.data;
    expect(team.members.map((m) => m.employee.name).sort()).toEqual(['Esha Employee', 'Leo Lead']);
  });
});

describe('idle intervals from the desktop agent', () => {
  it('are accepted only when the policy enables them, clipped to working time, and idempotent', async () => {
    const s = await setup();
    const c = await clients(s);
    const policy = (await c.owner.get('/monitoring/policies')).body.data[0];
    const settings = { captureEnabled: true, intervalS: 600, minIntervalS: 300, maxIntervalS: 1800, blur: false, captureMode: 'ACTIVE_SCREEN', excludedApps: [], idleDetectionEnabled: false, retentionDays: 30, noticeText: 'Screenshots and idle time while you are clocked in and working, as described here.' };
    await c.owner.post(`/monitoring/policies/${policy.id}/versions`, settings);
    await c.owner.patch(`/monitoring/policies/${policy.id}`, { isActive: true });
    const ack = async () => {
      const me = (await c.employee.get('/monitoring/me')).body.data;
      await c.employee.post('/monitoring/me/consent', { action: 'ACKNOWLEDGED', policyVersionId: me.version.id });
    };
    await ack();
    await workDay(c.employee);
    at('17:40');
    // Pair a device through the API, as the agent would.
    const { generateKeyPairSync } = await import('node:crypto');
    const raw = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
    const { code } = (await c.employee.post('/monitoring/me/pairing-codes')).body.data;
    const { default: request } = await import('supertest');
    const reg = await request(app).post('/api/v1/monitoring/agent/register').send({ pairingCode: code, publicKey: raw, deviceName: 'Laptop', os: 'darwin' });
    const idle = (body) => request(app).post('/api/v1/monitoring/agent/idle').set('Authorization', `Bearer ${reg.body.data.accessToken}`).send(body);

    const interval = { id: randomUUID(), startedAt: '2026-10-21T11:50:00Z', endedAt: '2026-10-21T12:20:00Z' };
    const refused = await idle({ intervals: [interval] });
    expect(refused.status).toBe(422);
    expect(refused.body.error.details[0].message).toBe('IDLE_DISABLED');

    await c.owner.post(`/monitoring/policies/${policy.id}/versions`, { ...settings, idleDetectionEnabled: true });
    await ack();
    expect((await idle({ intervals: [interval] })).body.data).toEqual({ recorded: 1 });
    expect((await idle({ intervals: [interval] })).body.data).toEqual({ recorded: 0 });
    const day = (await c.owner.get(`/activity/day?date=2026-10-21&employeeId=${s.emp.employeeId}`)).body.data;
    expect(day.stats.idleS).toBe(10 * 60); // 11:50–12:00; the break (12:00–12:30) is not working time
  });
});

describe('reports', () => {
  it('lists only the reports a person may run', async () => {
    const s = await setup();
    const c = await clients(s);
    expect((await c.employee.get('/reports')).body.data.map((r) => r.type).sort()).toEqual(['attendance', 'monitoring', 'tickets', 'time']);
    expect((await c.owner.get('/reports')).body.data.map((r) => r.type).sort()).toEqual(['attendance', 'leads', 'margins', 'monitoring', 'pipeline', 'projects', 'revenue', 'tickets', 'time']);
    expect((await c.employee.get('/reports/projects?from=2026-10-19&to=2026-10-21')).status).toBe(403);
  });

  it('computes attendance and time per member, scoped to the caller', async () => {
    const s = await setup();
    const c = await clients(s);
    await workDay(c.employee, '2026-10-20', { late: true });
    await workDay(c.employee, '2026-10-21');
    at('18:00');
    const att = (await c.owner.get('/reports/attendance?from=2026-10-19&to=2026-10-21')).body.data;
    const esha = att.rows.find((r) => r.label === 'Esha Employee');
    expect(esha).toMatchObject({ scheduledDays: 3, presentDays: 2, absentDays: 1, lateDays: 1, attendanceRate: 2 / 3 });
    expect(att.columns.find((col) => col.key === 'attendanceRate')).toMatchObject({ kind: 'derived', type: 'percent' });
    expect(att.columns.find((col) => col.key === 'workedS')).toMatchObject({ kind: 'measured' });

    const mine = (await c.employee.get('/reports/attendance?from=2026-10-19&to=2026-10-21')).body.data;
    expect(mine.rows.map((r) => r.label)).toEqual(['Esha Employee']);
    expect((await c.employee.get(`/reports/attendance?from=2026-10-19&to=2026-10-21&employeeId=${s.peer.employeeId}`)).status).toBe(403);

    const time = (await c.lead.get('/reports/time?from=2026-10-19&to=2026-10-21')).body.data;
    expect(time.rows.map((r) => r.label).sort()).toEqual(['Esha Employee', 'Leo Lead']);
    expect(time.rows.find((r) => r.label === 'Esha Employee')).toMatchObject({ billableS: 16 * H - 40 * 60, utilization: (16 * H - 40 * 60) / (24 * H) });
    const byDay = (await c.owner.get('/reports/time?from=2026-10-19&to=2026-10-21&groupBy=day')).body.data;
    expect(byDay.rows.map((r) => r.label)).toEqual(['2026-10-19', '2026-10-20', '2026-10-21']);
  });

  it('splits time by project and reports project throughput', async () => {
    const s = await setup();
    const c = await clients(s);
    const project = (await c.owner.post('/projects', { name: 'Portal', estimatedS: 16 * H }, key())).body.data;
    await c.owner.put(`/projects/${project.id}/members`, { members: [{ employeeId: s.emp.employeeId, role: 'MEMBER' }] });
    at('09:00');
    await c.employee.post('/time-entries', { startedAt: '2026-10-21T06:00:00Z', endedAt: '2026-10-21T08:00:00Z', projectId: project.id, isBillable: true }, key());
    await c.employee.post('/time-entries', { startedAt: '2026-10-21T08:00:00Z', endedAt: '2026-10-21T08:30:00Z' }, key());
    const byProject = (await c.owner.get('/reports/time?from=2026-10-21&to=2026-10-21&groupBy=project')).body.data;
    expect(byProject.rows).toEqual([
      expect.objectContaining({ label: `${project.code} · Portal`, trackedS: 2 * H, billableS: 2 * H, people: 1 }),
      expect.objectContaining({ label: 'No project', trackedS: 0.5 * H }),
    ]);
    const projects = (await c.owner.get('/reports/projects?from=2026-10-21&to=2026-10-21')).body.data;
    expect(projects.rows.find((r) => r.label.endsWith('Portal'))).toMatchObject({ trackedS: 2 * H, hoursUtilization: 2 / 16, estimatedS: 16 * H });
  });

  it('measures screenshot coverage against monitored time', async () => {
    const s = await setup();
    const c = await clients(s);
    const policy = (await c.owner.get('/monitoring/policies')).body.data[0];
    await c.owner.post(`/monitoring/policies/${policy.id}/versions`, { captureEnabled: true, intervalS: 1800, minIntervalS: 300, maxIntervalS: 3600, blur: false, captureMode: 'ACTIVE_SCREEN', excludedApps: [], idleDetectionEnabled: false, retentionDays: 30, noticeText: 'Screenshots while you are clocked in and working, every thirty minutes.' });
    await c.owner.patch(`/monitoring/policies/${policy.id}`, { isActive: true });
    at('08:30');
    const me = (await c.employee.get('/monitoring/me')).body.data;
    await c.employee.post('/monitoring/me/consent', { action: 'ACKNOWLEDGED', policyVersionId: me.version.id });
    await workDay(c.employee); // 8 h worked → 16 expected at 30 min
    const agent = await prisma.desktopAgent.create({ data: { organizationId: s.ctx.org.id, userId: s.emp.user.id, deviceName: 'L', os: 'darwin', publicKey: 'x' } });
    const shots = [...Array(12)].map((_, i) => ({ status: 'READY', failureCode: null, capturedAt: new Date(Date.parse('2026-10-21T09:10:00Z') + i * 1800_000) }));
    shots.push({ status: 'FAILED', failureCode: 'EXPIRED', capturedAt: new Date('2026-10-21T16:00:00Z') });
    for (const shot of shots) {
      await prisma.screenshot.create({ data: { organizationId: s.ctx.org.id, userId: s.emp.user.id, agentId: agent.id, policyVersionId: me.version.id, clientCaptureId: randomUUID(), ...shot } });
    }
    await prisma.statsDirtyDay.createMany({ data: [{ organizationId: s.ctx.org.id, userId: s.emp.user.id, date: new Date('2026-10-21T00:00:00Z') }], skipDuplicates: true });
    const report = (await c.owner.get('/reports/monitoring?from=2026-10-21&to=2026-10-21')).body.data;
    const esha = report.rows.find((r) => r.label === 'Esha Employee');
    expect(esha).toMatchObject({ monitoredS: 8 * H, screenshotsExpected: 16, screenshotsOk: 12, screenshotsFailed: 1, coverage: 12 / 16, failureRate: 1 / 13 });
    expect(report.meta.notes.join(' ')).toMatch(/not how much anyone worked/);
    // HR has attendance reports but not monitoring reports.
    expect((await c.hr.get('/reports/monitoring?from=2026-10-21&to=2026-10-21')).status).toBe(403);
  });

  it('refuses long synchronous ranges and bad groupings', async () => {
    const s = await setup();
    const { owner } = await clients(s);
    const long = await owner.get('/reports/attendance?from=2026-08-01&to=2026-10-21');
    expect(long.status).toBe(422);
    expect(long.body.error.code).toBe('REPORT_TOO_LARGE');
    expect((await owner.get('/reports/attendance?from=2026-10-01&to=2026-10-21&groupBy=project')).status).toBe(400);
  });
});

describe('report exports', () => {
  it('runs as a job, re-checks permission at download, and expires', async () => {
    const s = await setup();
    const c = await clients(s);
    await workDay(c.employee);
    at('18:00');
    const created = await c.owner.post('/reports/jobs', { type: 'attendance', format: 'csv', params: { from: '2026-09-01', to: '2026-10-21' } }, key());
    expect(created.status).toBe(201);
    expect(await prisma.outboxEvent.count({ where: { type: 'report.generate' } })).toBe(1);
    expect((await c.owner.get(`/reports/jobs/${created.body.data.id}/download`)).status).toBe(422); // not ready

    expect(await runReportJob({ prisma, storage, clock }, { organizationId: s.ctx.org.id, jobId: created.body.data.id })).toEqual({ status: 'COMPLETED' });
    const job = (await c.owner.get(`/reports/jobs/${created.body.data.id}`)).body.data;
    expect(job).toMatchObject({ status: 'COMPLETED', format: 'csv', fileName: 'attendance-2026-09-01-to-2026-10-21.csv' });
    const csv = storage.objects.get(`reports/${s.ctx.org.id}/${job.id}.csv`).body.toString();
    expect(csv.replace(/^\uFEFF/, '').split(/\r?\n/)[0]).toBe('Employee,Scheduled days,Days present,Days absent,Late days,Worked (h),Breaks (h),Overtime (h),Attendance rate (%)');
    expect(csv).toMatch(/Esha Employee,\d+,1,/);
    expect(csv).toMatch(/Column,Attendance rate,Kind,derived/);
    const link = await c.owner.get(`/reports/jobs/${job.id}/download`);
    expect(link.body.data.url).toMatch(/reports\//);
    expect(await prisma.auditLog.count({ where: { action: 'reports.exported' } })).toBe(1);

    // Only the requester sees the job; losing the permission blocks the download.
    expect((await c.hr.get(`/reports/jobs/${job.id}`)).status).toBe(404);
    const hrJob = await c.hr.post('/reports/jobs', { type: 'attendance', format: 'pdf', params: { from: '2026-10-01', to: '2026-10-21' } }, key());
    await runReportJob({ prisma, storage, clock }, { organizationId: s.ctx.org.id, jobId: hrJob.body.data.id });
    expect(storage.objects.get(`reports/${s.ctx.org.id}/${hrJob.body.data.id}.pdf`).body.subarray(0, 4).toString()).toBe('%PDF');
    await prisma.memberRole.deleteMany({ where: { organizationId: s.ctx.org.id, userId: s.hr.user.id } });
    const hrAgain = await login(app, s.hr.user.email);
    expect((await hrAgain.get(`/reports/jobs/${hrJob.body.data.id}/download`)).status).toBe(403);

    clock.advance(8 * 86_400_000);
    expect(await expireReportJobs({ prisma, storage, clock })).toEqual({ expired: 2 });
    expect(storage.objects.has(`reports/${s.ctx.org.id}/${job.id}.csv`)).toBe(false);
  });

  it('fails a queued job whose requester lost access', async () => {
    const s = await setup();
    const c = await clients(s);
    const job = (await c.hr.post('/reports/jobs', { type: 'attendance', format: 'csv', params: { from: '2026-10-01', to: '2026-10-21' } }, key())).body.data;
    await prisma.memberRole.deleteMany({ where: { organizationId: s.ctx.org.id, userId: s.hr.user.id } });
    expect(await runReportJob({ prisma, storage, clock }, { organizationId: s.ctx.org.id, jobId: job.id })).toEqual({ status: 'FAILED' });
    expect((await prisma.reportJob.findFirst({ where: { organizationId: s.ctx.org.id, id: job.id } })).error).toMatch(/access/);
  });
});

describe('stats freshness', () => {
  it('computes within a budget and queues a backfill beyond it', async () => {
    const s = await setup();
    at('18:00');
    const userIds = [s.emp.user.id, s.peer.user.id];
    const dates = ['2026-10-19', '2026-10-20', '2026-10-21'];
    expect(await ensureStats(prisma, { organizationId: s.ctx.org.id, userIds, dates, now: clock.now(), budget: 4 })).toMatchObject({ complete: false });
    expect(await prisma.outboxEvent.count({ where: { type: 'stats.backfill' } })).toBe(1);
    expect(await ensureStats(prisma, { organizationId: s.ctx.org.id, userIds, dates, now: clock.now() })).toMatchObject({ complete: true });
    expect(await prisma.dailyMemberStat.count({ where: { organizationId: s.ctx.org.id } })).toBe(6);
    expect(await processDirtyStats(prisma, { now: clock.now() })).toEqual({ days: 0 });
  });

  it('builds weekly trends for everyone in scope', async () => {
    const s = await setup();
    const c = await clients(s);
    await workDay(c.employee);
    at('18:00');
    const trends = (await c.owner.get('/activity/trends?weeks=4')).body.data;
    expect(trends.series).toHaveLength(4);
    expect(trends.series.at(-1)).toMatchObject({ weekStart: '2026-10-19', partial: true, trackedS: 8 * H });
    expect(trends.people).toBe(5);
  });
});
