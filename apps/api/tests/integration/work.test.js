import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp } from '../helpers/test-app.js';
import { resetDatabase } from '../helpers/db.js';
import { createMember, createOrg, login } from '../helpers/factories.js';

const { app, prisma, clock } = buildTestApp();
afterAll(() => prisma.$disconnect());
beforeEach(() => resetDatabase(prisma));

const MIN = 60_000;
let n = 0;
const key = () => ({ 'Idempotency-Key': `work-test-${Date.now()}-${++n}` });

async function employee(profile = {}) {
  const ctx = await createOrg(prisma);
  await prisma.organization.update({ where: { id: ctx.org.id }, data: { timeZone: 'Asia/Kolkata' } });
  const member = await createMember(prisma, ctx, { profile });
  return { ctx, member, client: await login(app, member.user.email) };
}

describe('clock in / out and breaks', () => {
  it('runs a full day with server timestamps and a summary', async () => {
    clock.set('2026-10-21T03:30:00Z'); // 09:00 in Kolkata
    const { client } = await employee();
    const inRes = await client.post('/attendance/clock-in', { note: 'Start' }, key());
    expect(inRes.status).toBe(201);
    expect(inRes.body.data).toMatchObject({ state: 'WORKING', timeZone: 'Asia/Kolkata', session: { startedAt: '2026-10-21T03:30:00.000Z' } });

    clock.advance(180 * MIN);
    expect((await client.post('/attendance/break/start')).body.data.state).toBe('ON_BREAK');
    clock.advance(30 * MIN);
    expect((await client.post('/attendance/break/end')).body.data.state).toBe('WORKING');
    clock.advance(330 * MIN);
    const live = (await client.get('/attendance/state')).body.data;
    expect(live.today.workedS).toBe(510 * 60); // 3h + 5.5h, break excluded

    const out = await client.post('/attendance/clock-out', undefined, key());
    expect(out.body.data.state).toBe('OFF');
    const record = await prisma.unscoped.attendanceRecord.findFirst({});
    expect(record).toMatchObject({ workedS: 510 * 60, breakS: 1800, status: 'PRESENT' });
    expect(record.workDate.toISOString().slice(0, 10)).toBe('2026-10-21');
  });

  it('rejects invalid transitions', async () => {
    const { client } = await employee();
    expect((await client.post('/attendance/clock-out', undefined, key())).body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect((await client.post('/attendance/break/start')).status).toBe(409);
    await client.post('/attendance/clock-in', {}, key());
    const again = await client.post('/attendance/clock-in', {}, key());
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect((await client.post('/attendance/break/end')).status).toBe(409);
  });

  it('allows exactly one of 20 concurrent clock-ins', async () => {
    const { client, ctx, member } = await employee();
    const results = await Promise.all(Array.from({ length: 20 }, () => client.post('/attendance/clock-in', {}, key())));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s !== 201).every((s) => s === 409)).toBe(true);
    expect(await prisma.workSession.count({ where: { organizationId: ctx.org.id, userId: member.user.id } })).toBe(1);
  });

  it('replays a retried clock-in with the same idempotency key instead of failing', async () => {
    const { client } = await employee();
    const headers = key();
    const first = await client.post('/attendance/clock-in', {}, headers);
    const retry = await client.post('/attendance/clock-in', {}, headers);
    expect(retry.status).toBe(201);
    expect(retry.body).toEqual(first.body);
  });

  it('attributes an overnight session to the day it started', async () => {
    clock.set('2026-10-21T16:30:00Z'); // 22:00 Kolkata
    const { client } = await employee();
    await client.post('/attendance/clock-in', {}, key());
    clock.advance(8 * 60 * MIN); // 06:00 next day
    await client.post('/attendance/clock-out', undefined, key());
    const records = await prisma.unscoped.attendanceRecord.findMany({});
    expect(records).toHaveLength(1);
    expect(records[0].workDate.toISOString().slice(0, 10)).toBe('2026-10-21');
    expect(records[0].workedS).toBe(8 * 3600);
  });

  it('flags late arrival against the schedule beyond the grace period', async () => {
    const { ctx, member, client } = await employee();
    const schedule = await prisma.workSchedule.create({
      data: { organizationId: ctx.org.id, name: 'Day', isDefault: true, days: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '09:00', end: '18:00' })) },
    });
    expect(schedule.id).toBeTruthy();
    clock.set('2026-10-21T03:55:00Z'); // 09:25 local, 25 minutes late (grace 10)
    await client.post('/attendance/clock-in', {}, key());
    const record = await prisma.attendanceRecord.findFirst({ where: { organizationId: ctx.org.id, userId: member.user.id } });
    expect(record.lateByS).toBe(25 * 60);
    expect(record.flags).toContain('LATE');
    expect(record.scheduleSnapshot.window.expectedS).toBe(9 * 3600);
  });
});

describe('timer', () => {
  it('starts, pauses, resumes, switches and stops, producing non-overlapping entries', async () => {
    clock.set('2026-10-21T04:00:00Z');
    const { client, ctx, member } = await employee();
    const started = await client.post('/time-tracking/start', { description: 'API work', isBillable: true }, key());
    expect(started.status).toBe(201);
    expect(started.body.data).toMatchObject({ state: 'WORKING', timer: { state: 'RUNNING', entry: { description: 'API work', isBillable: true } } });

    clock.advance(30 * MIN);
    expect((await client.post('/time-tracking/pause')).body.data.timer.state).toBe('PAUSED');
    clock.advance(10 * MIN);
    expect((await client.post('/time-tracking/resume')).body.data.timer.entry.description).toBe('API work');
    clock.advance(20 * MIN);
    await client.post('/time-tracking/switch', { description: 'Code review' });
    clock.advance(15 * MIN);
    // Page refresh: state is recovered from the server, including the running segment.
    const recovered = (await client.get('/time-tracking/active')).body.data;
    expect(recovered).toMatchObject({ state: 'RUNNING', entry: { description: 'Code review' } });
    expect((await client.get('/attendance/state')).body.data.today).toMatchObject({ trackedS: 65 * 60, billableS: 50 * 60 });

    await client.post('/time-tracking/stop', undefined, key());
    const entries = await prisma.timeEntry.findMany({ where: { organizationId: ctx.org.id, userId: member.user.id }, orderBy: { startedAt: 'asc' } });
    expect(entries.map((e) => [e.description, e.durationS])).toEqual([
      ['API work', 1800],
      ['API work', 1200],
      ['Code review', 900],
    ]);
    for (let i = 1; i < entries.length; i += 1) expect(entries[i].startedAt >= entries[i - 1].endedAt).toBe(true);
  });

  it('pauses the timer for a break and stops it at clock-out', async () => {
    clock.set('2026-10-21T04:00:00Z');
    const { client } = await employee();
    await client.post('/time-tracking/start', { description: 'Work' }, key());
    clock.advance(20 * MIN);
    const onBreak = (await client.post('/attendance/break/start')).body.data;
    expect(onBreak.timer.state).toBe('PAUSED');
    expect((await client.post('/time-tracking/resume')).status).toBe(409);
    await client.post('/attendance/break/end');
    await client.post('/time-tracking/resume');
    clock.advance(10 * MIN);
    const out = (await client.post('/attendance/clock-out', undefined, key())).body.data;
    expect(out.timer.state).toBe('NONE');
    expect(await prisma.unscoped.timeEntry.count({ where: { endedAt: null } })).toBe(0);
  });

  it('requires clock-in when the organization disables auto clock-in', async () => {
    const { client, ctx } = await employee();
    const owner = await login(app, ctx.owner.email);
    await owner.put('/organizations/current/settings/timeTracking', { requireClockInForTimer: true, autoClockInOnTimerStart: false, allowManualEntries: true, timesheetPeriod: 'WEEKLY' });
    const res = await client.post('/time-tracking/start', { description: 'x' }, key());
    expect(res.status).toBe(422);
    expect((await client.post('/time-tracking/start', { description: 'x' }, key())).status).toBe(422);
  });
});
