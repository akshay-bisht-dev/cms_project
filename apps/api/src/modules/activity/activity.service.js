import { DateTime } from 'luxon';
import { ForbiddenError } from '../../utils/errors.js';
import { isoDate, localDate, localDateRange, overlapping } from '../../utils/time.js';
import { coversMember } from '../rbac/rbac.service.js';
import { memberSummaries, resolveEmployeeUserId } from '../shared/members.js';
import { memberCalendar } from '../attendance/schedule.js';
import { scopedMembers } from '../reports/definitions.js';
import { recomputeMemberDays } from './rollup.js';
import { aggregateStats, datesBetween, ensureStats } from './stats.js';
import { emptyTotals, finishTotals, mergeTotals, summarize, trackedTime } from './kpi.js';

const PERMISSION = 'reports.attendance.read';
const MONITORING = 'reports.monitoring.read';
const MONITORING_KEYS = ['monitoredS', 'screenshotsExpected', 'screenshotsOk', 'screenshotsFailed', 'coverage', 'failureRate', 'idleS'];

/** Removes monitoring figures the viewer may not see for this person. */
function withoutMonitoring(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => !MONITORING_KEYS.includes(k)));
}

const serializeStat = (r) =>
  r && {
    date: isoDate(r.date),
    status: r.status,
    scheduledS: r.scheduledS,
    workedS: r.workedS,
    breakS: r.breakS,
    lateByS: r.lateByS,
    overtimeS: r.overtimeS,
    trackedS: r.trackedS,
    billableS: r.billableS,
    idleS: r.idleS,
    monitoredS: r.monitoredS,
    screenshotsExpected: r.screenshotsExpected,
    screenshotsOk: r.screenshotsOk,
    screenshotsFailed: r.screenshotsFailed,
    tasksCompleted: r.tasksCompleted,
    computedAt: r.computedAt,
  };

export function createActivityService({ prisma, clock }) {
  async function target(ctx, employeeId) {
    const userId = employeeId ? await resolveEmployeeUserId(prisma, ctx.orgId, employeeId, 'query.employeeId') : ctx.userId;
    if (!(await coversMember(prisma, ctx, PERMISSION, userId))) throw new ForbiddenError('You cannot view this person’s activity');
    const seesMonitoring = await coversMember(prisma, ctx, MONITORING, userId);
    const { zone } = await memberCalendar(prisma, ctx.orgId, userId);
    return { userId, seesMonitoring, zone };
  }

  async function projectNames(ctx, ids) {
    const unique = [...new Set(ids.filter(Boolean))];
    if (!unique.length) return new Map();
    const rows = await prisma.project.findMany({ where: { organizationId: ctx.orgId, id: { in: unique } }, select: { id: true, code: true, name: true } });
    return new Map(rows.map((p) => [p.id, { id: p.id, code: p.code, name: p.name }]));
  }

  return {
    /** One person's day: totals, a time-ordered event list and the intervals behind them. */
    async day(ctx, { employeeId, date }) {
      const now = clock.now();
      const { userId, seesMonitoring, zone } = await target(ctx, employeeId);
      const [start, end] = localDateRange(date, date, zone);
      if (date <= localDate(now, zone)) await recomputeMemberDays(prisma, ctx.orgId, userId, [date], now);
      const [stat, events, entries, sessions] = await Promise.all([
        prisma.dailyMemberStat.findFirst({ where: { organizationId: ctx.orgId, userId, date: new Date(`${date}T00:00:00Z`) } }),
        prisma.activityEvent.findMany({ where: { organizationId: ctx.orgId, userId, occurredAt: { gte: start, lt: end } }, orderBy: { occurredAt: 'asc' }, take: 1000 }),
        prisma.timeEntry.findMany({
          where: { organizationId: ctx.orgId, userId, deletedAt: null, ...overlapping(start, end) },
          select: { id: true, startedAt: true, endedAt: true, isBillable: true, projectId: true, description: true },
          orderBy: { startedAt: 'asc' },
        }),
        prisma.workSession.findMany({ where: { organizationId: ctx.orgId, userId, ...overlapping(start, end) }, include: { breaks: true }, orderBy: { startedAt: 'asc' } }),
      ]);
      const visible = events.filter((e) => seesMonitoring || e.type !== 'agent.idle');
      const projects = await projectNames(ctx, [...entries.map((e) => e.projectId), ...visible.map((e) => e.projectId)]);
      const people = await memberSummaries(prisma, ctx.orgId, [userId]);
      const byProject = trackedTime(entries, { start, end }, now).byProject.map((p) => ({ project: projects.get(p.projectId) ?? null, trackedS: p.trackedS, billableS: p.billableS }));
      const day = serializeStat(stat);
      return {
        employee: { id: people.get(userId)?.employeeId ?? null, name: people.get(userId)?.name ?? null },
        date,
        timeZone: zone,
        window: { start, end },
        includesMonitoring: seesMonitoring,
        stats: day ? (seesMonitoring ? day : withoutMonitoring(day)) : null,
        sessions: sessions.map((s) => ({ startedAt: s.startedAt, endedAt: s.endedAt, breaks: s.breaks.map((b) => ({ startedAt: b.startedAt, endedAt: b.endedAt })) })),
        timeEntries: entries.map((e) => ({ id: e.id, startedAt: e.startedAt, endedAt: e.endedAt, isBillable: e.isBillable, description: e.description, project: projects.get(e.projectId) ?? null })),
        byProject: byProject.sort((a, b) => b.trackedS - a.trackedS),
        events: visible.map((e) => ({ id: e.id, type: e.type, at: e.occurredAt, durationS: e.durationS, subjectType: e.subjectType, subjectId: e.subjectId, project: projects.get(e.projectId) ?? null })),
      };
    },

    /** Seven days from `weekStart` with daily totals, the week's summary and project split. */
    async week(ctx, { employeeId, weekStart }) {
      const now = clock.now();
      const { userId, seesMonitoring, zone } = await target(ctx, employeeId);
      const dates = datesBetween(weekStart, DateTime.fromISO(weekStart).plus({ days: 6 }).toISODate());
      await ensureStats(prisma, { organizationId: ctx.orgId, userIds: [userId], dates, now });
      const rows = await prisma.dailyMemberStat.findMany({ where: { organizationId: ctx.orgId, userId, date: { gte: new Date(`${dates[0]}T00:00:00Z`), lte: new Date(`${dates[6]}T00:00:00Z`) } }, orderBy: { date: 'asc' } });
      const [start, end] = localDateRange(dates[0], dates[6], zone);
      const entries = await prisma.timeEntry.findMany({
        where: { organizationId: ctx.orgId, userId, deletedAt: null, ...overlapping(start, end) },
        select: { startedAt: true, endedAt: true, isBillable: true, projectId: true },
      });
      const split = trackedTime(entries, { start, end }, now).byProject;
      const projects = await projectNames(ctx, split.map((p) => p.projectId));
      const strip = (o) => (seesMonitoring ? o : withoutMonitoring(o));
      const byDate = new Map(rows.map((r) => [isoDate(r.date), serializeStat(r)]));
      return {
        timeZone: zone,
        includesMonitoring: seesMonitoring,
        days: dates.map((d) => strip(byDate.get(d) ?? { date: d, status: 'NONE', future: true })),
        summary: strip(summarize(rows)),
        byProject: split.map((p) => ({ project: projects.get(p.projectId) ?? null, trackedS: p.trackedS, billableS: p.billableS })).sort((a, b) => b.trackedS - a.trackedS),
      };
    },

    /** Team overview for a day: everyone in scope with that day's totals and current state. */
    async team(ctx, { date, teamId, departmentId }) {
      const now = clock.now();
      const members = await scopedMembers(prisma, ctx, PERMISSION, { teamId, departmentId });
      const userIds = members.map((m) => m.userId);
      const { complete } = await ensureStats(prisma, { organizationId: ctx.orgId, userIds, dates: [date], now });
      const [rows, states] = await Promise.all([
        prisma.dailyMemberStat.findMany({ where: { organizationId: ctx.orgId, userId: { in: userIds }, date: new Date(`${date}T00:00:00Z`) } }),
        prisma.memberWorkState.findMany({ where: { organizationId: ctx.orgId, userId: { in: userIds } }, select: { userId: true, state: true, timerState: true } }),
      ]);
      const byUser = new Map(rows.map((r) => [r.userId, serializeStat(r)]));
      const stateOf = new Map(states.map((s) => [s.userId, s]));
      const out = [];
      for (const m of members) {
        const stat = byUser.get(m.userId) ?? null;
        const sees = await coversMember(prisma, ctx, MONITORING, m.userId);
        out.push({ employee: { id: m.employeeId, name: m.name }, state: stateOf.get(m.userId)?.state ?? 'OFF', timerRunning: stateOf.get(m.userId)?.timerState === 'RUNNING', stats: stat && (sees ? stat : withoutMonitoring(stat)) });
      }
      return { date, complete, members: out, summary: withoutMonitoring(summarize(rows)) };
    },

    /**
     * Weekly trends for everyone in scope. Monitoring figures cover only the people whose
     * monitoring reports the viewer may see.
     */
    async trends(ctx, { weeks, teamId, departmentId }) {
      const now = clock.now();
      const zone = ctx.organization?.timeZone ?? 'UTC';
      const weekStart = ctx.organization?.weekStart ?? 1;
      const today = DateTime.fromISO(localDate(now, zone));
      const currentStart = today.minus({ days: (today.weekday - weekStart + 7) % 7 });
      const firstStart = currentStart.minus({ weeks: weeks - 1 });
      const dates = datesBetween(firstStart.toISODate(), today.toISODate());

      const members = await scopedMembers(prisma, ctx, PERMISSION, { teamId, departmentId });
      const userIds = members.map((m) => m.userId);
      const { complete } = await ensureStats(prisma, { organizationId: ctx.orgId, userIds, dates, now });
      const monitored = new Set();
      for (const id of userIds) if (await coversMember(prisma, ctx, MONITORING, id)) monitored.add(id);
      // Per-date totals from the database (a few rows), not every person-day.
      const range = { organizationId: ctx.orgId, from: dates[0], to: dates.at(-1), by: 'date' };
      const allByDate = await aggregateStats(prisma, { ...range, userIds });
      const monByDate = monitored.size === userIds.length ? allByDate : await aggregateStats(prisma, { ...range, userIds: [...monitored] });
      const total = (byDate, from, to) => [...byDate].filter(([d]) => d >= from && d <= to).reduce((t, [, v]) => mergeTotals(t, v), emptyTotals());

      const series = [];
      for (let i = 0; i < weeks; i += 1) {
        const from = firstStart.plus({ weeks: i }).toISODate();
        const to = firstStart.plus({ weeks: i, days: 6 }).toISODate();
        const all = finishTotals(total(allByDate, from, to));
        const mon = finishTotals(total(monByDate, from, to));
        series.push({
          weekStart: from,
          partial: to > today.toISODate(),
          ...withoutMonitoring(all),
          ...(monitored.size ? { coverage: mon.coverage, failureRate: mon.failureRate, idleS: mon.idleS } : {}),
        });
      }
      return { weeks, people: members.length, monitoredPeople: monitored.size, complete, series };
    },
  };
}
