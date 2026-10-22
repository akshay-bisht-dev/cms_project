import { dateOnly, isoDate, localDate, localDateRange, overlapping, scheduleWindow } from '../../utils/time.js';
import { memberCalendar } from '../attendance/schedule.js';
import { resolveEffectivePolicy } from '../monitoring/policy.js';
import { consentWindows, expectedCaptures, intersectIntervals, totalSeconds, trackedTime, workTime } from './kpi.js';
import { approvedLeaveHalves } from '../leave/jobs.js';

const OK_STATUSES = ['READY', 'UPLOADED'];
const FAILED_STATUSES = ['FAILED', 'REJECTED'];
const DAY_MS = 86_400_000;

/**
 * Rebuilds one member's stats for one local date from the source tables. Every number comes
 * from records (sessions, breaks, time entries, captures, tasks); nothing is estimated.
 * Worked time belongs to the date its session started (as in attendance); tracked, idle and
 * capture figures are clipped to the local day.
 */
export async function computeMemberDay(db, organizationId, userId, date, now) {
  const [record, member] = await Promise.all([
    db.attendanceRecord.findFirst({ where: { organizationId, userId, workDate: dateOnly(date) } }),
    db.organizationMember.findUnique({ where: { organizationId_userId: { organizationId, userId } }, select: { joinedAt: true, createdAt: true } }),
  ]);
  const calendar = await memberCalendar(db, organizationId, userId);
  const zone = record?.timeZone ?? calendar.zone;
  const [start, end] = localDateRange(date, date, zone);
  const window = { start, end };
  const nowMs = now.getTime();

  const [holiday, sessions, entries, idleEvents, captures, tasksCompleted] = await Promise.all([
    db.holiday.findFirst({ where: { organizationId, date: dateOnly(date) } }),
    record ? db.workSession.findMany({ where: { organizationId, attendanceRecordId: record.id }, include: { breaks: true } }) : [],
    db.timeEntry.findMany({
      where: { organizationId, userId, deletedAt: null, ...overlapping(start, end) },
      select: { startedAt: true, endedAt: true, isBillable: true, projectId: true },
    }),
    db.activityEvent.findMany({
      where: { organizationId, userId, type: 'agent.idle', occurredAt: { gte: new Date(start.getTime() - DAY_MS), lt: end } },
      select: { occurredAt: true, durationS: true },
    }),
    db.screenshot.findMany({
      where: { organizationId, userId, capturedAt: { gte: start, lt: end }, status: { not: 'PENDING_UPLOAD' } },
      select: { status: true, failureCode: true, deletedAt: true, policyVersionId: true, capturedAt: true },
      orderBy: { capturedAt: 'desc' },
    }),
    db.task.count({ where: { organizationId, completedAt: { gte: start, lt: end }, assignees: { some: { userId } } } }),
  ]);

  // Scheduled time: the snapshot taken when the day started, else the current schedule.
  let scheduledS = record?.scheduleSnapshot?.window?.expectedS ?? scheduleWindow(calendar.schedule, date, zone)?.expectedS ?? 0;
  if (holiday) scheduledS = holiday.isHalfDay ? Math.round(scheduledS / 2) : 0;
  const joined = member?.joinedAt ?? member?.createdAt;
  if (joined && end <= joined) scheduledS = 0;
  // Approved leave removes its share of the scheduled time (utilization = billable ÷ (schedule − holidays − leave)).
  const leaveHalves = (await approvedLeaveHalves(db, organizationId, userId, date, date)).get(date) ?? 0;
  if (leaveHalves) scheduledS = Math.round((scheduledS * (2 - leaveHalves)) / 2);

  const { workedS, breakS, workedIntervals } = workTime(sessions, now);
  const { trackedS, billableS } = trackedTime(entries, window, now);
  const idleS = totalSeconds(idleEvents.map((e) => ({ start: e.occurredAt, end: new Date(e.occurredAt.getTime() + (e.durationS ?? 0) * 1000) })), window);

  // Captures: deleted ones (retention, manual) still count as captured; failures never do.
  const ok = captures.filter((c) => OK_STATUSES.includes(c.status) || (c.status === 'DELETED' && !c.failureCode)).length;
  const failed = captures.filter((c) => FAILED_STATUSES.includes(c.status)).length;

  // Monitored time = worked time while the member's acknowledgement was in force, at the
  // interval of the policy version that governed that day's captures (else the current one).
  let monitoredS = 0;
  let intervalS = null;
  const versionId = captures[0]?.policyVersionId;
  if (versionId) {
    const v = await db.monitoringPolicyVersion.findFirst({ where: { organizationId, id: versionId } });
    intervalS = v ? Math.min(Math.max(v.intervalS, v.minIntervalS), v.maxIntervalS) : null;
  } else if (workedS > 0) {
    const effective = await resolveEffectivePolicy(db, organizationId, userId);
    if (effective.enabled) intervalS = effective.settings.intervalS;
  }
  if (intervalS) {
    const consents = await db.monitoringConsentRecord.findMany({ where: { organizationId, userId, createdAt: { lt: end } }, select: { action: true, createdAt: true } });
    monitoredS = totalSeconds(intersectIntervals(workedIntervals, consentWindows(consents, now)));
  }

  let status = 'NONE';
  if (sessions.length) status = 'PRESENT';
  else if (holiday && !holiday.isHalfDay) status = 'HOLIDAY';
  else if (leaveHalves) status = 'LEAVE';
  else if (record?.status === 'ABSENT' || (scheduledS > 0 && end.getTime() <= nowMs)) status = 'ABSENT';

  return {
    organizationId,
    userId,
    date: dateOnly(date),
    timeZone: zone,
    status,
    scheduledS,
    workedS,
    breakS,
    lateByS: record?.lateByS ?? 0,
    overtimeS: record?.overtimeS ?? 0,
    trackedS,
    billableS,
    idleS,
    monitoredS,
    screenshotsExpected: expectedCaptures(monitoredS, intervalS),
    screenshotsOk: ok,
    screenshotsFailed: failed,
    tasksCompleted,
    computedAt: now,
  };
}

export async function recomputeMemberDays(db, organizationId, userId, dates, now) {
  for (const date of new Set(dates)) {
    const data = await computeMemberDay(db, organizationId, userId, date, now);
    const { organizationId: o, userId: u, date: d, ...values } = data;
    await db.dailyMemberStat.upsert({
      where: { organizationId_userId_date: { organizationId: o, userId: u, date: d } },
      create: data,
      update: values,
    });
  }
}

/** Local dates (in the member's zone) that a UTC calendar date overlaps: one or two. */
function localDatesForUtcDate(utc, zone) {
  const start = new Date(`${utc}T00:00:00.000Z`);
  return [...new Set([localDate(start, zone), localDate(new Date(start.getTime() + DAY_MS - 1), zone)])];
}

/**
 * Rebuilds dirty days. Restrict with `organizationId` / `userIds` to refresh just what a report
 * is about to read. A mark made while a day is being rebuilt survives (only marks older than
 * the rebuild start are cleared), so no change is ever lost.
 */
export async function processDirtyStats(prisma, { now, organizationId, userIds, limit = 2000 } = {}) {
  // Database time, because marks are stamped with the database clock.
  const [{ t: startedAt }] = await prisma.$queryRaw`SELECT NOW(3) AS t`;
  const where = { ...(organizationId ? { organizationId } : {}), ...(userIds ? { userId: { in: userIds } } : {}) };
  const client = organizationId ? prisma : prisma.unscoped;
  const dirty = await client.statsDirtyDay.findMany({ where, orderBy: { markedAt: 'asc' }, take: limit });
  const byMember = new Map();
  for (const d of dirty) {
    const key = `${d.organizationId}|${d.userId}`;
    byMember.set(key, [...(byMember.get(key) ?? []), d]);
  }
  for (const [key, rows] of byMember) {
    const [orgId, userId] = key.split('|');
    const { zone } = await memberCalendar(prisma, orgId, userId);
    const dates = rows.flatMap((r) => localDatesForUtcDate(isoDate(r.date), zone));
    await recomputeMemberDays(prisma, orgId, userId, dates, now);
    await prisma.statsDirtyDay.deleteMany({ where: { organizationId: orgId, userId, date: { in: rows.map((r) => r.date) }, markedAt: { lt: startedAt } } });
  }
  return { days: dirty.length };
}

/**
 * Nightly safety net: rebuilds yesterday and today for every active member, which also covers
 * changes that leave no mark (schedules, holidays, absences, policy changes).
 */
export async function recomputeRecentStats(prisma, { now, logger }) {
  const members = await prisma.unscoped.organizationMember.findMany({ where: { status: 'ACTIVE', memberType: 'EMPLOYEE' }, select: { organizationId: true, userId: true } });
  for (const m of members) {
    const { zone } = await memberCalendar(prisma, m.organizationId, m.userId);
    const today = localDate(now, zone);
    const yesterday = localDate(new Date(now.getTime() - DAY_MS), zone);
    await recomputeMemberDays(prisma, m.organizationId, m.userId, [yesterday, today], now);
  }
  logger?.info({ members: members.length }, 'daily stats recomputed');
  return { members: members.length };
}
