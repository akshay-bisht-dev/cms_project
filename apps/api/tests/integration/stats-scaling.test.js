import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from '../helpers/test-app.js';
import { resetDatabase } from '../helpers/db.js';
import { createMember, createOrg } from '../helpers/factories.js';
import { memberCalendar, memberZones } from '../../src/modules/attendance/schedule.js';
import { backfillStats, ensureStats, trackedTimeByProject } from '../../src/modules/activity/stats.js';
import { trackedTime } from '../../src/modules/activity/kpi.js';

// Phase 11 load test findings: team-wide reads must not cost queries per person, must not rebuild
// "today" for a whole organization on every read, and must stay inside the request timeout.
const { prisma } = buildTestApp();
const db = prisma.unscoped;
const counting = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL, log: [{ emit: 'event', level: 'query' }] });
let queries = 0;
counting.$on('query', () => {
  queries += 1;
});
counting.unscoped = counting;

const now = new Date('2026-10-21T12:00:00Z');
const days = ['2026-10-19', '2026-10-20', '2026-10-21'];
let ctx;
let people;

beforeAll(async () => {
  await resetDatabase(db);
  ctx = await createOrg(prisma);
  await db.organization.update({ where: { id: ctx.org.id }, data: { timeZone: 'Asia/Kolkata' } });
  const dept = await db.department.create({ data: { organizationId: ctx.org.id, name: 'Eng', code: 'ENG' } });
  const team = await db.team.create({ data: { organizationId: ctx.org.id, name: 'Night shift' } });
  const schedule = (name, timeZone) => db.workSchedule.create({ data: { organizationId: ctx.org.id, name, timeZone, days: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '09:00', end: '17:00' })) } });
  const [ny, london, tokyo] = await Promise.all([schedule('NY office', 'America/New_York'), schedule('London office', 'Europe/London'), schedule('Floating', null)]);
  await db.workSchedule.create({ data: { organizationId: ctx.org.id, name: 'Default', isDefault: true, timeZone: 'Asia/Tokyo', days: [] } });
  people = [];
  for (let i = 0; i < 16; i += 1) {
    const zone = i % 4 === 0 ? 'Europe/Berlin' : null;
    people.push(await createMember(prisma, ctx, { name: `P${i}`, profile: { timeZone: zone, departmentId: i % 3 === 0 ? dept.id : null } }));
  }
  const uid = (i) => people[i].user.id;
  await db.teamMember.create({ data: { organizationId: ctx.org.id, teamId: team.id, userId: uid(1) } });
  await db.scheduleAssignment.create({ data: { organizationId: ctx.org.id, scheduleId: ny.id, targetType: 'MEMBER', targetId: uid(0) } });
  await db.scheduleAssignment.create({ data: { organizationId: ctx.org.id, scheduleId: london.id, targetType: 'TEAM', targetId: team.id } });
  await db.scheduleAssignment.create({ data: { organizationId: ctx.org.id, scheduleId: tokyo.id, targetType: 'DEPARTMENT', targetId: dept.id } });
});
afterAll(async () => {
  await counting.$disconnect();
  await prisma.$disconnect();
});

describe('team-wide stats', () => {
  it('resolves zones in bulk exactly as memberCalendar does, one person at a time', async () => {
    const ids = people.map((p) => p.user.id);
    const zones = await memberZones(db, ctx.org.id, ids);
    for (const id of ids) expect(zones.get(id)).toBe((await memberCalendar(db, ctx.org.id, id)).zone);
    // Sanity: the precedence cases are all represented.
    expect(new Set(zones.values())).toEqual(new Set(['America/New_York', 'Europe/London', 'Europe/Berlin', 'Asia/Tokyo', 'Asia/Kolkata']));
  });

  it('does not issue more queries per person (4 vs 16 people) once stats exist', async () => {
    const ids = people.map((p) => p.user.id);
    await backfillStats(db, { organizationId: ctx.org.id, from: days[0], to: days.at(-1), now });
    const run = async (n) => {
      queries = 0;
      await ensureStats(counting, { organizationId: ctx.org.id, userIds: ids.slice(0, n), dates: days, now: new Date(now.getTime() + 1000) });
      return queries;
    };
    const small = await run(4);
    const large = await run(16);
    // Flat in the number of people (Prisma may batch a relation load differently: ±2); the old
    // per-person zone lookup cost ~4 queries each.
    expect(large - small).toBeLessThanOrEqual(2);
    expect(large).toBeLessThan(15);
  });

  it('refreshes a stale "today" inline for a small view and in the background for a large one', async () => {
    const ids = people.map((p) => p.user.id);
    const later = new Date(now.getTime() + 5 * 60_000); // every "today" row is now stale
    const before = await db.dailyMemberStat.findMany({ where: { organizationId: ctx.org.id, userId: ids[2] } });

    const large = await ensureStats(db, { organizationId: ctx.org.id, userIds: ids, dates: days, now: later, syncTodayLimit: 10 });
    expect(large.refreshing).toBe(16);
    expect(large.computed).toBe(0);
    const queued = await db.outboxEvent.findFirst({ where: { type: 'stats.refresh', organizationId: ctx.org.id } });
    expect(queued.payload.userIds).toHaveLength(16);
    expect(await db.dailyMemberStat.findMany({ where: { organizationId: ctx.org.id, userId: ids[2] } })).toEqual(before);

    const small = await ensureStats(db, { organizationId: ctx.org.id, userIds: ids.slice(0, 2), dates: days, now: later, syncTodayLimit: 10 });
    expect(small.refreshing).toBe(0);
    expect(small.computed).toBe(2);
  });

  it('stops at the time budget and defers the rest, while the background backfill always finishes', async () => {
    await db.dailyMemberStat.deleteMany({ where: { organizationId: ctx.org.id } });
    const ids = people.map((p) => p.user.id);
    const partial = await ensureStats(db, { organizationId: ctx.org.id, userIds: ids, dates: days, now, timeBudgetMs: 0 });
    expect(partial.complete).toBe(false);
    expect(await db.outboxEvent.count({ where: { type: 'stats.backfill', organizationId: ctx.org.id } })).toBe(1);
    const full = await backfillStats(db, { organizationId: ctx.org.id, from: days[0], to: days.at(-1), now });
    expect(full.complete).toBe(true);
  });
});

describe('tracked time aggregated by the database', () => {
  it('matches kpi.trackedTime exactly, including running, edge-crossing, zero-length and deleted entries', async () => {
    const [a, b] = await Promise.all(['ALPHA', 'BETA'].map((code) => db.project.create({ data: { organizationId: ctx.org.id, code, name: code } })));
    const users = people.slice(0, 3).map((p) => p.user.id);
    const start = new Date('2026-10-20T00:00:00Z');
    const end = new Date('2026-10-21T00:00:00Z');
    const clock = new Date('2026-10-20T15:30:00.250Z');
    let seed = 7;
    const rand = (n) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const rows = [];
    for (let i = 0; i < 300; i += 1) {
      // Starts from 30 h before the window to 6 h after it, with millisecond offsets.
      const st = new Date(start.getTime() - 30 * 3_600_000 + rand(60 * 3_600_000) + rand(1000));
      const kind = rand(10);
      const en = kind === 0 ? null : kind === 1 ? st : new Date(st.getTime() + rand(20 * 3_600_000) + rand(1000));
      rows.push({ organizationId: ctx.org.id, userId: users[rand(3)], projectId: [a.id, b.id, null][rand(3)], isBillable: rand(2) === 0, startedAt: st, endedAt: en, durationS: 0, deletedAt: rand(15) === 0 ? st : null });
    }
    await db.timeEntry.createMany({ data: rows });

    const sql = await trackedTimeByProject(db, { organizationId: ctx.org.id, userIds: users, start, end, now: clock });
    const entries = await db.timeEntry.findMany({ where: { organizationId: ctx.org.id, userId: { in: users }, deletedAt: null, startedAt: { lt: end }, OR: [{ endedAt: null }, { endedAt: { gt: start } }] } });
    const js = trackedTime(entries, { start, end }, clock);
    const sort = (list) => [...list].sort((x, y) => String(x.projectId).localeCompare(String(y.projectId)));
    expect(sql.trackedS).toBe(js.trackedS);
    expect(sql.billableS).toBe(js.billableS);
    expect(sort(sql.byProject).map(({ people: _p, ...r }) => r)).toEqual(sort(js.byProject));
    expect(sql.people).toBe(new Set(entries.map((e) => e.userId)).size);
    expect(js.trackedS).toBeGreaterThan(0);
  });
});
