import pino from 'pino';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp } from '../helpers/test-app.js';
import { resetDatabase } from '../helpers/db.js';
import { createMember, createOrg, login } from '../helpers/factories.js';
import { closeMissedClockOuts, markAbsences } from '../../src/modules/attendance/jobs.js';
import { createFieldCipher } from '../../src/services/crypto.js';

const { app, prisma, clock, env } = buildTestApp();
const cipher = createFieldCipher(env.FIELD_ENCRYPTION_KEYS);
const logger = pino({ level: 'silent' });
afterAll(() => prisma.$disconnect());
beforeEach(async () => {
  clock.set('2026-10-21T07:00:00Z');
  await resetDatabase(prisma);
});

const MIN = 60_000;
let n = 0;
const key = () => ({ 'Idempotency-Key': `att-test-${Date.now()}-${++n}` });
const WEEKDAYS_9_TO_6 = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '09:00', end: '18:00' }));

async function setup() {
  const ctx = await createOrg(prisma);
  await prisma.organization.update({ where: { id: ctx.org.id }, data: { timeZone: 'UTC' } });
  const lead = await createMember(prisma, ctx, { role: 'TEAM_LEAD', name: 'Lead' });
  const dev = await createMember(prisma, ctx, { name: 'Dev', profile: { managerUserId: lead.user.id } });
  const outsider = await createMember(prisma, ctx, { name: 'Outsider' });
  const team = await prisma.team.create({ data: { organizationId: ctx.org.id, name: 'T', leadUserId: lead.user.id } });
  await prisma.teamMember.createMany({ data: [lead, dev].map((m) => ({ organizationId: ctx.org.id, teamId: team.id, userId: m.user.id })) });
  return { ...ctx, lead, dev, outsider, team };
}

async function workShift(client, startIso, minutes) {
  clock.set(startIso);
  await client.post('/attendance/clock-in', {}, key());
  clock.advance(minutes * MIN);
  await client.post('/attendance/clock-out', undefined, key());
}

describe('attendance records and the board', () => {
  it('lists my records with totals and lets team leads see their team only', async () => {
    const s = await setup();
    const dev = await login(app, s.dev.user.email);
    await workShift(dev, '2026-10-19T09:00:00Z', 480);
    await workShift(dev, '2026-10-20T09:00:00Z', 420);

    const mine = await dev.get('/attendance/records?from=2026-10-19&to=2026-10-25');
    expect(mine.body.data.map((r) => r.workDate)).toEqual(['2026-10-20', '2026-10-19']);
    expect(mine.body.meta.totals.workedS).toBe(900 * 60);

    const lead = await login(app, s.lead.user.email);
    expect((await lead.get(`/attendance/records?from=2026-10-19&to=2026-10-25&employeeId=${s.dev.employeeId}`)).body.data).toHaveLength(2);
    expect((await lead.get(`/attendance/records?from=2026-10-19&to=2026-10-25&employeeId=${s.outsider.employeeId}`)).status).toBe(403);
    expect((await dev.get(`/attendance/records?from=2026-10-19&to=2026-10-25&employeeId=${s.lead.employeeId}`)).status).toBe(403);
    expect((await dev.get('/attendance/records?from=2026-10-25&to=2026-10-19')).status).toBe(400);
  });

  it('shows live presence on the board, scoped to the viewer', async () => {
    const s = await setup();
    await prisma.workSchedule.create({ data: { organizationId: s.org.id, name: 'Std', isDefault: true, days: WEEKDAYS_9_TO_6 } });
    clock.set('2026-10-21T10:00:00Z');
    const dev = await login(app, s.dev.user.email);
    await dev.post('/attendance/clock-in', {}, key());

    const lead = await login(app, s.lead.user.email);
    const board = (await lead.get('/attendance/board')).body.data;
    expect(board.items.map((i) => [i.name, i.presence]).sort()).toEqual([
      ['Dev', 'WORKING'],
      ['Lead', 'ABSENT'],
    ]);
    const owner = (await (await login(app, s.owner.email)).get('/attendance/board')).body.data;
    expect(owner.items).toHaveLength(4);
    expect((await dev.get('/attendance/board')).status).toBe(200); // employees see only themselves
    expect((await dev.get('/attendance/board')).body.data.items).toHaveLength(1);
  });
});

describe('corrections', () => {
  it('runs request → approve → apply with the original kept, and blocks self-approval', async () => {
    const s = await setup();
    const dev = await login(app, s.dev.user.email);
    await workShift(dev, '2026-10-20T09:30:00Z', 450);
    const [record] = (await dev.get('/attendance/records?from=2026-10-20&to=2026-10-20')).body.data;
    const session = record.sessions[0];

    clock.set('2026-10-21T08:00:00Z');
    const req = await dev.post(
      '/attendance/corrections',
      { kind: 'MODIFY', workSessionId: session.id, proposedStartAt: '2026-10-20T09:00:00Z', proposedEndAt: '2026-10-20T17:00:00Z', reason: 'Forgot to clock in on arrival' },
      key(),
    );
    expect(req.status).toBe(201);
    expect(req.body.data.original.startedAt).toBe('2026-10-20T09:30:00.000Z');
    expect((await dev.post('/attendance/corrections', { kind: 'MODIFY', workSessionId: session.id, proposedStartAt: '2026-10-20T09:00:00Z', proposedEndAt: '2026-10-20T17:00:00Z', reason: 'again' }, key())).status).toBe(409);

    const lead = await login(app, s.lead.user.email);
    const n1 = (await lead.get('/notifications')).body.data;
    expect(n1[0].type).toBe('attendance.correction_requested');
    const queue = (await lead.get('/attendance/corrections?mine=false')).body.data;
    expect(queue.map((c) => c.employee.name)).toEqual(['Dev']);
    expect((await dev.post(`/attendance/corrections/${req.body.data.id}/approve`, {})).status).toBe(403);

    expect((await lead.post(`/attendance/corrections/${req.body.data.id}/approve`, { comment: 'ok' })).status).toBe(200);
    const [after] = (await dev.get('/attendance/records?from=2026-10-20&to=2026-10-20')).body.data;
    expect(after.workedS).toBe(8 * 3600);
    expect(after.flags).toContain('CORRECTED');
    expect((await lead.post(`/attendance/corrections/${req.body.data.id}/approve`, {})).status).toBe(409);
    expect((await dev.get('/notifications')).body.data[0].type).toBe('attendance.correction_decided');
  });

  it('adds a forgotten day, rejects overlaps and future times, and deletes on approval', async () => {
    const s = await setup();
    clock.set('2026-10-21T08:00:00Z');
    const dev = await login(app, s.dev.user.email);
    const add = await dev.post('/attendance/corrections', { kind: 'ADD', proposedStartAt: '2026-10-19T09:00:00Z', proposedEndAt: '2026-10-19T13:00:00Z', reason: 'Worked offline' }, key());
    expect(add.status).toBe(201);
    const future = await dev.post('/attendance/corrections', { kind: 'ADD', proposedStartAt: '2026-10-21T07:00:00Z', proposedEndAt: '2026-10-21T09:00:00Z', reason: 'x x x' }, key());
    expect(future.status).toBe(400);
    const lead = await login(app, s.lead.user.email);
    await lead.post(`/attendance/corrections/${add.body.data.id}/approve`, {});
    const overlap = await dev.post('/attendance/corrections', { kind: 'ADD', proposedStartAt: '2026-10-19T12:00:00Z', proposedEndAt: '2026-10-19T14:00:00Z', reason: 'dup' }, key());
    expect(overlap.status).toBe(409);
    expect(overlap.body.error.code).toBe('OVERLAP');

    const [record] = (await dev.get('/attendance/records?from=2026-10-19&to=2026-10-19')).body.data;
    expect(record.workedS).toBe(4 * 3600);
    const del = await dev.post('/attendance/corrections', { kind: 'DELETE', workSessionId: record.sessions[0].id, reason: 'Entered by mistake' }, key());
    await lead.post(`/attendance/corrections/${del.body.data.id}/reject`, { comment: 'Keep it' });
    expect((await dev.get('/attendance/records?from=2026-10-19&to=2026-10-19')).body.data[0].workedS).toBe(4 * 3600);
  });
});

describe('background jobs', () => {
  it('auto-closes a forgotten session at the scheduled end and notifies the employee', async () => {
    const s = await setup();
    await prisma.workSchedule.create({ data: { organizationId: s.org.id, name: 'Std', isDefault: true, days: WEEKDAYS_9_TO_6 } });
    clock.set('2026-10-21T09:00:00Z');
    const dev = await login(app, s.dev.user.email);
    await dev.post('/time-tracking/start', { description: 'Work' }, key());

    clock.set('2026-10-21T21:00:00Z'); // 18:00 + 4h grace not yet passed
    expect((await closeMissedClockOuts({ prisma, clock, cipher, env, logger })).closed).toBe(0);
    clock.set('2026-10-21T22:30:00Z');
    expect((await closeMissedClockOuts({ prisma, clock, cipher, env, logger })).closed).toBe(1);
    expect((await closeMissedClockOuts({ prisma, clock, cipher, env, logger })).closed).toBe(0); // idempotent

    // 13.5 hours later the earlier browser session has idled out; sign in again.
    const devAgain = await login(app, s.dev.user.email);
    const state = (await devAgain.get('/attendance/state')).body.data;
    expect(state).toMatchObject({ state: 'OFF', timer: { state: 'NONE' } });
    const [record] = (await devAgain.get('/attendance/records?from=2026-10-21&to=2026-10-21')).body.data;
    expect(record.flags).toContain('MISSED_CLOCK_OUT');
    // No activity after the start was recorded, so the session closes at the scheduled end.
    expect(record.sessions[0]).toMatchObject({ endReason: 'AUTO_CLOSED', endedAt: '2026-10-21T18:00:00.000Z' });
    const [entry] = (await devAgain.get('/time-entries?from=2026-10-21&to=2026-10-21')).body.data;
    expect(entry).toMatchObject({ running: false, durationS: 9 * 3600 });
    expect((await devAgain.get('/notifications')).body.data[0].type).toBe('attendance.missed_clock_out');
  });

  it('closes at the last recorded activity when it is earlier than the scheduled end', async () => {
    const s = await setup();
    await prisma.workSchedule.create({ data: { organizationId: s.org.id, name: 'Std', isDefault: true, days: WEEKDAYS_9_TO_6 } });
    clock.set('2026-10-21T09:00:00Z');
    const dev = await login(app, s.dev.user.email);
    await dev.post('/attendance/clock-in', {}, key());
    clock.set('2026-10-21T12:00:00Z');
    await dev.post('/attendance/break/start');
    clock.set('2026-10-21T12:30:00Z');
    await dev.post('/attendance/break/end'); // last activity
    clock.set('2026-10-22T03:00:00Z');
    await closeMissedClockOuts({ prisma, clock, cipher, env, logger });
    const [session] = await prisma.workSession.findMany({ where: { organizationId: s.org.id, userId: s.dev.user.id } });
    expect(session.endedAt.toISOString()).toBe('2026-10-21T12:30:00.000Z');
    const record = await prisma.attendanceRecord.findFirst({ where: { organizationId: s.org.id, userId: s.dev.user.id } });
    expect(record.workedS).toBe(3 * 3600);
  });

  it('marks absences only for scheduled working days without attendance or holidays', async () => {
    const s = await setup();
    await prisma.workSchedule.create({ data: { organizationId: s.org.id, name: 'Std', isDefault: true, days: WEEKDAYS_9_TO_6 } });
    await prisma.organizationMember.updateMany({ where: { organizationId: s.org.id }, data: { joinedAt: new Date('2026-01-01') } });
    const dev = await login(app, s.dev.user.email);
    await workShift(dev, '2026-10-20T09:00:00Z', 60);

    expect((await markAbsences({ prisma, organizationId: s.org.id, date: '2026-10-20', logger })).marked).toBe(3);
    expect((await markAbsences({ prisma, organizationId: s.org.id, date: '2026-10-20', logger })).marked).toBe(0);
    expect((await markAbsences({ prisma, organizationId: s.org.id, date: '2026-10-25', logger })).marked).toBe(0); // Sunday
    await prisma.holiday.create({ data: { organizationId: s.org.id, date: new Date('2026-10-22T00:00:00Z'), name: 'Festival' } });
    expect((await markAbsences({ prisma, organizationId: s.org.id, date: '2026-10-22', logger })).marked).toBe(0);
    const devRecords = (await dev.get('/attendance/records?from=2026-10-20&to=2026-10-20')).body.data;
    expect(devRecords[0].status).toBe('PRESENT');
  });
});

describe('schedules and holidays', () => {
  it('resolves schedules by precedence: member over team over default', async () => {
    const s = await setup();
    const owner = await login(app, s.owner.email);
    const def = (await owner.post('/attendance/schedules', { name: 'Default', isDefault: true, days: WEEKDAYS_9_TO_6 })).body.data;
    const night = (await owner.post('/attendance/schedules', { name: 'Night', days: [{ weekday: 3, start: '22:00', end: '06:00' }] })).body.data;
    const early = (await owner.post('/attendance/schedules', { name: 'Early', days: [{ weekday: 3, start: '06:00', end: '14:00' }] })).body.data;
    expect(def.isDefault).toBe(true);
    expect((await owner.post('/attendance/schedules', { name: 'Bad', days: [{ weekday: 3, start: '25:00', end: '06:00' }] })).status).toBe(400);
    await owner.post(`/attendance/schedules/${night.id}/assignments`, { targetType: 'TEAM', targetId: s.team.id });
    await owner.post(`/attendance/schedules/${early.id}/assignments`, { targetType: 'MEMBER', targetId: s.dev.employeeId });

    clock.set('2026-10-21T05:00:00Z');
    const dev = await login(app, s.dev.user.email);
    const lead = await login(app, s.lead.user.email);
    await dev.post('/attendance/clock-in', {}, key());
    await lead.post('/attendance/clock-in', {}, key());
    const devRecord = (await dev.get('/attendance/records?from=2026-10-21&to=2026-10-21')).body.data[0];
    const leadRecord = (await lead.get('/attendance/records?from=2026-10-21&to=2026-10-21')).body.data[0];
    expect(devRecord.expected.start).toBe('2026-10-21T06:00:00.000Z');
    expect(leadRecord.expected.start).toBe('2026-10-21T22:00:00.000Z');

    const dev2 = await login(app, s.dev.user.email);
    expect((await dev2.post('/attendance/schedules', { name: 'Mine', days: [] })).status).toBe(403);
    expect((await owner.post('/attendance/holidays', { date: '2026-12-25', name: 'Christmas' })).status).toBe(201);
    expect((await dev2.get('/attendance/holidays?year=2026')).body.data).toEqual([expect.objectContaining({ date: '2026-12-25', name: 'Christmas' })]);
  });
});
