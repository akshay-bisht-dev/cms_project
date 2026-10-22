import { ERROR_CODES } from '@orbit/shared-constants';
import { BusinessRuleError, ConflictError } from '../../utils/errors.js';
import { localDate, localDateRange, secondsBetween } from '../../utils/time.js';
import { withTransaction } from '../../repositories/tx.js';
import { memberCalendar } from './schedule.js';
import { recomputeRecord, recordForInstant } from './attendance-records.js';
import { recordActivity } from '../activity/activity.js';

const invalid = (message) => new ConflictError(message, ERROR_CODES.INVALID_STATE_TRANSITION);

/**
 * Creates the member's state row if missing, in its own autocommitted statement. Doing this
 * outside the transition transaction matters: an INSERT inside it takes gap locks, and concurrent
 * first-time transitions then deadlock (MySQL 1213) instead of simply queueing on the row lock.
 */
export async function ensureWorkStateRow(db, organizationId, userId) {
  await db.$executeRaw`
    INSERT IGNORE INTO member_work_states (organization_id, user_id, state, timer_state, version, updated_at)
    VALUES (${organizationId}, ${userId}, 'OFF', 'NONE', 0, NOW(3))`;
}

/**
 * Locks the member's (existing) state row for the rest of the transaction and returns its values.
 * The locking read always sees the latest committed state, so transitions serialize per member.
 */
export async function lockWorkState(tx, organizationId, userId) {
  const [row] = await tx.$queryRaw`
    SELECT state, work_session_id AS workSessionId, break_session_id AS breakSessionId, timer_state AS timerState,
           time_entry_id AS timeEntryId, timer_context AS timerContext, version
    FROM member_work_states WHERE organization_id = ${organizationId} AND user_id = ${userId} FOR UPDATE`;
  return { ...row, timerContext: typeof row.timerContext === 'string' ? JSON.parse(row.timerContext) : row.timerContext };
}

async function saveState(tx, organizationId, userId, state, now) {
  await tx.memberWorkState.update({
    where: { organizationId_userId: { organizationId, userId } },
    data: { ...state, lastActivityAt: now, version: { increment: 1 } },
  });
}

/** Closes the running timer segment (if any) at `at`. Returns the closed entry. */
export async function closeTimerEntry(tx, organizationId, entryId, at) {
  if (!entryId) return null;
  const entry = await tx.timeEntry.findFirst({ where: { organizationId, id: entryId } });
  if (!entry || entry.endedAt) return entry;
  const endedAt = at > entry.startedAt ? at : entry.startedAt;
  return tx.timeEntry.update({
    where: { organizationId_id: { organizationId, id: entry.id } },
    data: { endedAt, durationS: secondsBetween(entry.startedAt, endedAt), version: { increment: 1 } },
  });
}

/** Closes an open session (and its open break) at `at` and refreshes the day's summary. */
export async function closeSession(tx, organizationId, sessionId, at, endReason, settings) {
  const session = await tx.workSession.findFirst({ where: { organizationId, id: sessionId } });
  const endedAt = at > session.startedAt ? at : session.startedAt;
  await tx.breakSession.updateMany({ where: { organizationId, workSessionId: sessionId, endedAt: null }, data: { endedAt } });
  await tx.workSession.update({ where: { organizationId_id: { organizationId, id: sessionId } }, data: { endedAt, endReason } });
  await recomputeRecord(tx, organizationId, session.attendanceRecordId, settings);
  return endedAt;
}

/** Activity event for a work-state transition (subject: the session or the time entry). */
function activity(tx, ctx, type, now, extra = {}) {
  return recordActivity(tx, { organizationId: ctx.orgId, userId: ctx.userId, type, occurredAt: now, ...extra });
}

export function createWorkService({ prisma, clock, taskService }) {
  /** Runs a state transition under the member lock and returns the fresh state afterwards. */
  async function transition(ctx, apply) {
    await ensureWorkStateRow(prisma, ctx.orgId, ctx.userId);
    await withTransaction(prisma, async (tx) => {
      const now = clock.now();
      const state = await lockWorkState(tx, ctx.orgId, ctx.userId);
      await apply(tx, state, now);
    });
    ctx.afterCommit?.push((realtime) => realtime.emitToMember(ctx.orgId, ctx.userId, 'presence.changed', {}));
    ctx.afterCommit?.push((realtime) => realtime.emitToOrgPresence?.(ctx.orgId, { userId: ctx.userId }));
    return getState(ctx);
  }

  async function clockInTx(tx, ctx, state, now, { note, source = 'WEB' } = {}) {
    if (state.state !== 'OFF') throw invalid('You are already clocked in');
    const record = await recordForInstant(tx, ctx.orgId, ctx.userId, now);
    const session = await tx.workSession.create({
      data: { organizationId: ctx.orgId, userId: ctx.userId, attendanceRecordId: record.id, startedAt: now, source, note: note ?? null },
    });
    await recomputeRecord(tx, ctx.orgId, record.id, ctx.orgSettings?.attendance);
    await saveState(tx, ctx.orgId, ctx.userId, { state: 'WORKING', workSessionId: session.id, breakSessionId: null }, now);
    await activity(tx, ctx, 'attendance.clock_in', now, { subjectType: 'work_session', subjectId: session.id, metadata: { source } });
    return { ...state, state: 'WORKING', workSessionId: session.id };
  }

  async function startEntry(tx, ctx, state, now, rawContext, type = 'timer.started') {
    // Project/task must exist, belong together, and the member must be on the project.
    const resolved = taskService ? await taskService.assertTrackable(tx, ctx, rawContext) : {};
    const context = { ...rawContext, projectId: resolved.projectId ?? null, taskId: resolved.taskId ?? null };
    const entry = await tx.timeEntry.create({
      data: {
        organizationId: ctx.orgId,
        userId: ctx.userId,
        workSessionId: state.workSessionId,
        description: context.description ?? null,
        isBillable: context.isBillable ?? false,
        projectId: context.projectId ?? null,
        taskId: context.taskId ?? null,
        startedAt: now,
        source: 'TIMER',
      },
    });
    await saveState(tx, ctx.orgId, ctx.userId, { timerState: 'RUNNING', timeEntryId: entry.id, timerContext: context }, now);
    await activity(tx, ctx, type, now, { subjectType: 'time_entry', subjectId: entry.id, projectId: entry.projectId, metadata: entry.taskId ? { taskId: entry.taskId } : null });
  }

  async function getState(ctx) {
    const now = clock.now();
    const state = await prisma.memberWorkState.findUnique({ where: { organizationId_userId: { organizationId: ctx.orgId, userId: ctx.userId } } });
    const [session, openBreak, entry, calendar] = await Promise.all([
      state?.workSessionId ? prisma.workSession.findFirst({ where: { organizationId: ctx.orgId, id: state.workSessionId } }) : null,
      state?.breakSessionId ? prisma.breakSession.findFirst({ where: { organizationId: ctx.orgId, id: state.breakSessionId } }) : null,
      state?.timeEntryId && state.timerState === 'RUNNING' ? prisma.timeEntry.findFirst({ where: { organizationId: ctx.orgId, id: state.timeEntryId } }) : null,
      memberCalendar(prisma, ctx.orgId, ctx.userId),
    ]);

    // Today's totals in the member's zone, including the still-open session and timer segment.
    const today = localDate(now, calendar.zone);
    const [from, to] = localDateRange(today, today, calendar.zone);
    const [record, entries] = await Promise.all([
      prisma.attendanceRecord.findFirst({ where: { organizationId: ctx.orgId, userId: ctx.userId, workDate: new Date(`${today}T00:00:00Z`) } }),
      prisma.timeEntry.findMany({
        where: { organizationId: ctx.orgId, userId: ctx.userId, deletedAt: null, startedAt: { gte: from, lt: to } },
        select: { startedAt: true, endedAt: true, durationS: true, isBillable: true },
      }),
    ]);
    let workedS = record?.workedS ?? 0;
    if (session && !session.endedAt && localDate(session.startedAt, calendar.zone) === today) {
      const breaks = await prisma.breakSession.findMany({ where: { organizationId: ctx.orgId, workSessionId: session.id } });
      const breakS = breaks.reduce((sum, b) => sum + secondsBetween(b.startedAt, b.endedAt ?? now), 0);
      workedS += Math.max(0, secondsBetween(session.startedAt, now) - breakS);
    }
    const trackedS = entries.reduce((sum, e) => sum + (e.endedAt ? e.durationS : secondsBetween(e.startedAt, now)), 0);
    const billableS = entries.filter((e) => e.isBillable).reduce((sum, e) => sum + (e.endedAt ? e.durationS : secondsBetween(e.startedAt, now)), 0);

    return {
      serverTime: now.toISOString(),
      timeZone: calendar.zone,
      state: state?.state ?? 'OFF',
      session: session && !session.endedAt ? { id: session.id, startedAt: session.startedAt } : null,
      break: openBreak && !openBreak.endedAt ? { startedAt: openBreak.startedAt } : null,
      timer: {
        state: state?.timerState ?? 'NONE',
        entry: entry ? { id: entry.id, startedAt: entry.startedAt, description: entry.description, isBillable: entry.isBillable } : null,
        context: state?.timerContext ?? null,
      },
      today: { date: today, workedS, trackedS, billableS },
      version: state?.version ?? 0,
    };
  }

  return {
    getState,

    clockIn: (ctx, body) => transition(ctx, (tx, state, now) => clockInTx(tx, ctx, state, now, body)),

    clockOut: (ctx) =>
      transition(ctx, async (tx, state, now) => {
        if (state.state === 'OFF') throw invalid('You are not clocked in');
        await closeTimerEntry(tx, ctx.orgId, state.timeEntryId, now);
        await closeSession(tx, ctx.orgId, state.workSessionId, now, 'CLOCK_OUT', ctx.orgSettings?.attendance);
        await saveState(tx, ctx.orgId, ctx.userId, { state: 'OFF', workSessionId: null, breakSessionId: null, timerState: 'NONE', timeEntryId: null, timerContext: null }, now);
        await activity(tx, ctx, 'attendance.clock_out', now, { subjectType: 'work_session', subjectId: state.workSessionId });
      }),

    startBreak: (ctx) =>
      transition(ctx, async (tx, state, now) => {
        if (state.state !== 'WORKING') throw invalid(state.state === 'ON_BREAK' ? 'You are already on a break' : 'Clock in before taking a break');
        const pause = state.timerState === 'RUNNING';
        if (pause) await closeTimerEntry(tx, ctx.orgId, state.timeEntryId, now);
        const brk = await tx.breakSession.create({ data: { organizationId: ctx.orgId, workSessionId: state.workSessionId, startedAt: now } });
        // A running timer is paused for the break; the member resumes it explicitly afterwards.
        await saveState(tx, ctx.orgId, ctx.userId, { state: 'ON_BREAK', breakSessionId: brk.id, ...(pause ? { timerState: 'PAUSED', timeEntryId: null } : {}) }, now);
        await activity(tx, ctx, 'attendance.break_start', now, { subjectType: 'work_session', subjectId: state.workSessionId });
      }),

    endBreak: (ctx) =>
      transition(ctx, async (tx, state, now) => {
        if (state.state !== 'ON_BREAK') throw invalid('You are not on a break');
        await tx.breakSession.updateMany({ where: { organizationId: ctx.orgId, id: state.breakSessionId, endedAt: null }, data: { endedAt: now } });
        await saveState(tx, ctx.orgId, ctx.userId, { state: 'WORKING', breakSessionId: null }, now);
        await activity(tx, ctx, 'attendance.break_end', now, { subjectType: 'work_session', subjectId: state.workSessionId });
      }),

    startTimer: (ctx, context) =>
      transition(ctx, async (tx, state, now) => {
        const tracking = ctx.orgSettings?.timeTracking ?? {};
        if (state.state === 'ON_BREAK') throw invalid('End your break before starting the timer');
        if (state.timerState === 'RUNNING') throw invalid('A timer is already running; stop it or switch tasks');
        let current = state;
        if (state.state === 'OFF') {
          if (tracking.requireClockInForTimer !== false && !tracking.autoClockInOnTimerStart) {
            throw new BusinessRuleError('Clock in before starting the timer', ERROR_CODES.INVALID_STATE_TRANSITION);
          }
          if (tracking.requireClockInForTimer !== false) current = await clockInTx(tx, ctx, state, now, {});
        }
        await startEntry(tx, ctx, current, now, context);
      }),

    pauseTimer: (ctx) =>
      transition(ctx, async (tx, state, now) => {
        if (state.timerState !== 'RUNNING') throw invalid('The timer is not running');
        await closeTimerEntry(tx, ctx.orgId, state.timeEntryId, now);
        await saveState(tx, ctx.orgId, ctx.userId, { timerState: 'PAUSED', timeEntryId: null }, now);
        await activity(tx, ctx, 'timer.paused', now, { subjectType: 'time_entry', subjectId: state.timeEntryId });
      }),

    resumeTimer: (ctx) =>
      transition(ctx, async (tx, state, now) => {
        if (state.timerState !== 'PAUSED') throw invalid('The timer is not paused');
        if (state.state === 'ON_BREAK') throw invalid('End your break before resuming the timer');
        if (state.state === 'OFF' && ctx.orgSettings?.timeTracking?.requireClockInForTimer !== false) throw invalid('Clock in before resuming the timer');
        await startEntry(tx, ctx, state, now, state.timerContext ?? {}, 'timer.resumed');
      }),

    stopTimer: (ctx) =>
      transition(ctx, async (tx, state, now) => {
        if (state.timerState === 'NONE') throw invalid('No timer to stop');
        await closeTimerEntry(tx, ctx.orgId, state.timeEntryId, now);
        await saveState(tx, ctx.orgId, ctx.userId, { timerState: 'NONE', timeEntryId: null, timerContext: null }, now);
        await activity(tx, ctx, 'timer.stopped', now, { subjectType: 'time_entry', subjectId: state.timeEntryId });
      }),

    switchTimer: (ctx, context) =>
      transition(ctx, async (tx, state, now) => {
        if (state.timerState !== 'RUNNING') throw invalid('Start the timer before switching');
        await closeTimerEntry(tx, ctx.orgId, state.timeEntryId, now);
        await startEntry(tx, ctx, state, now, context, 'timer.switched');
      }),
  };
}
