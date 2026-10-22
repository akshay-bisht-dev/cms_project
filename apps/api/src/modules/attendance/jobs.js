import { DateTime } from 'luxon';
import { dateOnly, localDate, scheduleWindow } from '../../utils/time.js';
import { recordAudit } from '../../services/audit.js';
import { recordActivity } from '../activity/activity.js';
import { withTransaction } from '../../repositories/tx.js';
import { getOrganizationSettings } from '../organizations/settings.js';
import { notify } from '../notifications/notifications.service.js';
import { memberCalendar } from './schedule.js';
import { approvedLeaveHalves } from '../leave/jobs.js';
import { closeSession, closeTimerEntry, ensureWorkStateRow, lockWorkState } from './work.service.js';

const HOUR = 3_600_000;

/**
 * Closes sessions the member forgot to end (FR-ATT-3). A session is overdue once it passes
 * schedule end + missedClockOutGraceHours, or maxSessionHours after it started. It is closed at
 * the earliest defensible time: last recorded activity, else the scheduled end, else the cap.
 * Flagged MISSED_CLOCK_OUT for the member to correct. Safe to re-run.
 */
export async function closeMissedClockOuts({ prisma, clock, cipher, env, logger }) {
  const now = clock.now();
  // Cross-tenant scan by design; each session is then handled within its own organization.
  const open = await prisma.unscoped.workSession.findMany({
    where: { endedAt: null, startedAt: { lt: new Date(now.getTime() - HOUR) } },
    select: { id: true, organizationId: true, userId: true, startedAt: true, record: { select: { scheduleSnapshot: true } } },
    take: 500,
  });
  let closed = 0;
  for (const session of open) {
    const { settings } = await getOrganizationSettings(prisma, session.organizationId);
    const { maxSessionHours, missedClockOutGraceHours } = settings.attendance;
    const window = session.record.scheduleSnapshot?.window;
    const cap = new Date(session.startedAt.getTime() + maxSessionHours * HOUR);
    const scheduledEnd = window ? new Date(window.end) : null;
    const deadline = scheduledEnd ? new Date(Math.min(cap.getTime(), scheduledEnd.getTime() + missedClockOutGraceHours * HOUR)) : cap;
    if (now <= deadline) continue;

    await ensureWorkStateRow(prisma, session.organizationId, session.userId);
    const didClose = await withTransaction(prisma, async (tx) => {
      const state = await lockWorkState(tx, session.organizationId, session.userId);
      if (state.workSessionId !== session.id) return false; // clocked out meanwhile
      const activity = await tx.memberWorkState.findUnique({
        where: { organizationId_userId: { organizationId: session.organizationId, userId: session.userId } },
        select: { lastActivityAt: true },
      });
      const candidates = [cap, scheduledEnd, activity.lastActivityAt].filter((d) => d && d > session.startedAt);
      const closeAt = new Date(Math.min(...candidates.map((d) => d.getTime())));
      await closeTimerEntry(tx, session.organizationId, state.timeEntryId, closeAt);
      await closeSession(tx, session.organizationId, session.id, closeAt, 'AUTO_CLOSED', settings.attendance);
      await tx.memberWorkState.update({
        where: { organizationId_userId: { organizationId: session.organizationId, userId: session.userId } },
        data: { state: 'OFF', workSessionId: null, breakSessionId: null, timerState: 'NONE', timeEntryId: null, timerContext: null, version: { increment: 1 } },
      });
      await recordActivity(tx, { organizationId: session.organizationId, userId: session.userId, type: 'attendance.auto_closed', occurredAt: closeAt, subjectType: 'work_session', subjectId: session.id, affects: [now] });
      await recordAudit(tx, null, {
        action: 'attendance.auto_closed',
        organizationId: session.organizationId,
        actorType: 'SYSTEM',
        targetType: 'work_session',
        targetId: session.id,
        diff: { closeAt },
      });
      await notify(tx, null, {
        cipher,
        appOrigin: env.APP_ORIGIN,
        organizationId: session.organizationId,
        recipientUserId: session.userId,
        type: 'attendance.missed_clock_out',
        title: 'You did not clock out',
        body: `Your session was closed at ${closeAt.toISOString()}. If that is wrong, request a correction.`,
        link: '/attendance',
        subjectType: 'work_session',
        subjectId: session.id,
        dedupeKey: `missed-clock-out:${session.id}`,
      });
      return true;
    });
    if (didClose) closed += 1;
  }
  logger?.info({ closed, scanned: open.length }, 'missed clock-out check completed');
  return { closed };
}

/**
 * Marks ABSENT for active employees who were scheduled on `date` (their local date) but have no
 * attendance record and no holiday. Idempotent: the unique (member, work date) key prevents duplicates.
 */
export async function markAbsences({ prisma, organizationId, date, logger }) {
  const holiday = await prisma.holiday.findFirst({ where: { organizationId, date: dateOnly(date) } });
  if (holiday && !holiday.isHalfDay) return { marked: 0 };
  const members = await prisma.organizationMember.findMany({
    where: { organizationId, memberType: 'EMPLOYEE', status: 'ACTIVE' },
    select: { userId: true, joinedAt: true },
  });
  let marked = 0;
  for (const member of members) {
    if (member.joinedAt && localDate(member.joinedAt, 'UTC') > date) continue;
    const { zone, schedule } = await memberCalendar(prisma, organizationId, member.userId);
    const window = scheduleWindow(schedule, date, zone);
    if (!window) continue;
    try {
      await prisma.attendanceRecord.create({
        data: {
          organizationId,
          userId: member.userId,
          workDate: dateOnly(date),
          // Approved leave is not an absence (FR-ATT): the day is recorded as LEAVE.
          status: (await approvedLeaveHalves(prisma, organizationId, member.userId, date, date)).size ? 'LEAVE' : 'ABSENT',
          timeZone: zone,
          flags: [],
          scheduleSnapshot: { scheduleId: schedule.id, name: schedule.name, type: schedule.type, window: { start: window.start, end: window.end, expectedS: window.expectedS } },
        },
      });
      marked += 1;
    } catch (err) {
      if (err?.code !== 'P2002') throw err; // a record already exists: they worked or were marked
    }
  }
  logger?.info({ organizationId, date, marked }, 'absences marked');
  return { marked };
}

/** Runs markAbsences for "yesterday" in each organization's own time zone. */
export async function markAbsencesForAllOrganizations({ prisma, clock, logger }) {
  const orgs = await prisma.organization.findMany({ where: { status: { in: ['TRIAL', 'ACTIVE'] } }, select: { id: true, timeZone: true } });
  let marked = 0;
  for (const org of orgs) {
    const yesterday = DateTime.fromJSDate(clock.now(), { zone: org.timeZone }).minus({ days: 1 }).toISODate();
    marked += (await markAbsences({ prisma, organizationId: org.id, date: yesterday, logger })).marked;
  }
  return { marked };
}
