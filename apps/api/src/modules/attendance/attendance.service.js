import { ERROR_CODES } from '@orbit/shared-constants';
import { BusinessRuleError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { dateOnly, isoDate, localDate, scheduleWindow, secondsBetween } from '../../utils/time.js';
import { recordAudit } from '../../services/audit.js';
import { recordActivity } from '../activity/activity.js';
import { withTransaction } from '../../repositories/tx.js';
import { coversMember, memberCanActOn, resolveMemberScope } from '../rbac/rbac.service.js';
import { notify } from '../notifications/notifications.service.js';
import { memberCalendar } from './schedule.js';
import { recomputeRecord, recordForInstant } from './attendance-records.js';

const MAX_SESSION_S = 24 * 3600;

function serializeRecord(r) {
  return {
    id: r.id,
    workDate: isoDate(r.workDate),
    status: r.status,
    timeZone: r.timeZone,
    firstInAt: r.firstInAt,
    lastOutAt: r.lastOutAt,
    workedS: r.workedS,
    breakS: r.breakS,
    lateByS: r.lateByS,
    earlyByS: r.earlyByS,
    overtimeS: r.overtimeS,
    flags: r.flags,
    expected: r.scheduleSnapshot?.window ?? null,
    sessions: (r.sessions ?? []).map((s) => ({
      id: s.id,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      endReason: s.endReason,
      source: s.source,
      breaks: s.breaks.map((b) => ({ startedAt: b.startedAt, endedAt: b.endedAt })),
    })),
  };
}

function serializeCorrection(c, people) {
  return {
    id: c.id,
    employee: people?.get(c.userId) ?? null,
    workDate: isoDate(c.workDate),
    kind: c.kind,
    workSessionId: c.workSessionId,
    proposedStartAt: c.proposedStartAt,
    proposedEndAt: c.proposedEndAt,
    original: c.original,
    reason: c.reason,
    status: c.status,
    reviewedAt: c.reviewedAt,
    reviewComment: c.reviewComment,
    createdAt: c.createdAt,
  };
}

export function createAttendanceService({ prisma, clock, cipher, env }) {
  async function memberByEmployeeId(organizationId, employeeId) {
    const member = await prisma.organizationMember.findFirst({ where: { organizationId, id: employeeId }, include: { user: { select: { name: true } } } });
    if (!member) throw new NotFoundError('Employee not found');
    return member;
  }

  /** Resolves whose records to show: an employee in scope, or the caller. */
  async function targetUser(ctx, employeeId, permission) {
    if (!employeeId) return ctx.userId;
    const member = await memberByEmployeeId(ctx.orgId, employeeId);
    if (!(await coversMember(prisma, ctx, permission, member.userId))) throw new ForbiddenError('You cannot view this employee’s attendance');
    return member.userId;
  }

  async function people(organizationId, userIds) {
    const members = await prisma.organizationMember.findMany({
      where: { organizationId, userId: { in: [...new Set(userIds)] } },
      select: { id: true, userId: true, user: { select: { name: true } } },
    });
    return new Map(members.map((m) => [m.userId, { employeeId: m.id, name: m.user.name }]));
  }

  async function assertNoOverlap(tx, organizationId, userId, startAt, endAt, excludeSessionId) {
    const clash = await tx.workSession.findFirst({
      where: {
        organizationId,
        userId,
        ...(excludeSessionId ? { id: { not: excludeSessionId } } : {}),
        startedAt: { lt: endAt },
        OR: [{ endedAt: null }, { endedAt: { gt: startAt } }],
      },
    });
    if (clash) throw new ConflictError('This overlaps another work session', ERROR_CODES.OVERLAP);
  }

  function validateInterval(startAt, endAt, now) {
    if (!startAt || !endAt || endAt <= startAt) throw new ValidationError([{ path: 'body.proposedEndAt', message: 'The end must be after the start' }]);
    if (secondsBetween(startAt, endAt) > MAX_SESSION_S) throw new ValidationError([{ path: 'body.proposedEndAt', message: 'A session cannot exceed 24 hours' }]);
    if (endAt > now) throw new ValidationError([{ path: 'body.proposedEndAt', message: 'Corrections cannot be in the future' }]);
  }

  return {
    // ─── records ──────────────────────────────────────────────────────────

    async listRecords(ctx, { from, to, employeeId }) {
      const userId = await targetUser(ctx, employeeId, 'attendance.read');
      const records = await prisma.attendanceRecord.findMany({
        where: { organizationId: ctx.orgId, userId, workDate: { gte: dateOnly(from), lte: dateOnly(to) } },
        include: { sessions: { include: { breaks: true }, orderBy: { startedAt: 'asc' } } },
        orderBy: { workDate: 'desc' },
      });
      const totals = records.reduce(
        (acc, r) => ({
          workedS: acc.workedS + r.workedS,
          breakS: acc.breakS + r.breakS,
          lateDays: acc.lateDays + (r.lateByS > 0 ? 1 : 0),
          absentDays: acc.absentDays + (r.status === 'ABSENT' ? 1 : 0),
          overtimeS: acc.overtimeS + r.overtimeS,
        }),
        { workedS: 0, breakS: 0, lateDays: 0, absentDays: 0, overtimeS: 0 },
      );
      return { items: records.map(serializeRecord), totals };
    },

    /** Live board of everyone in the caller's attendance.read scope. */
    async board(ctx) {
      const scope = await resolveMemberScope(prisma, ctx, 'attendance.read');
      const now = clock.now();
      const members = await prisma.organizationMember.findMany({
        where: { organizationId: ctx.orgId, memberType: 'EMPLOYEE', status: 'ACTIVE', ...(scope.all ? {} : { userId: { in: [...scope.userIds] } }) },
        select: {
          id: true,
          userId: true,
          user: { select: { name: true } },
          profile: { select: { designation: true } },
          workState: { select: { state: true, workSessionId: true, lastActivityAt: true } },
        },
        orderBy: { user: { name: 'asc' } },
        take: 1000,
      });
      const rows = [];
      for (const m of members) {
        const calendar = await memberCalendar(prisma, ctx.orgId, m.userId);
        const today = localDate(now, calendar.zone);
        const record = await prisma.attendanceRecord.findFirst({
          where: { organizationId: ctx.orgId, userId: m.userId, workDate: dateOnly(today) },
        });
        const window = scheduleWindow(calendar.schedule, today, calendar.zone);
        const holiday = await prisma.holiday.findFirst({ where: { organizationId: ctx.orgId, date: dateOnly(today) } });
        let presence = m.workState?.state ?? 'OFF';
        if (presence === 'OFF') {
          if (record?.firstInAt) presence = 'CLOCKED_OUT';
          else if (holiday) presence = 'HOLIDAY';
          else if (window && now > window.start) presence = 'ABSENT';
          else presence = window ? 'NOT_STARTED' : 'NOT_SCHEDULED';
        }
        rows.push({
          employeeId: m.id,
          name: m.user.name,
          designation: m.profile?.designation ?? null,
          presence,
          firstInAt: record?.firstInAt ?? null,
          lateByS: record?.lateByS ?? 0,
          workedS: record?.workedS ?? 0,
          lastActivityAt: m.workState?.lastActivityAt ?? null,
        });
      }
      const counts = rows.reduce((acc, r) => ({ ...acc, [r.presence]: (acc[r.presence] ?? 0) + 1 }), {});
      return { generatedAt: now.toISOString(), counts, items: rows };
    },

    // ─── corrections ──────────────────────────────────────────────────────

    async requestCorrection(ctx, { kind, workSessionId, proposedStartAt, proposedEndAt, reason }) {
      const now = clock.now();
      return withTransaction(prisma, async (tx) => {
        let session = null;
        if (kind !== 'ADD') {
          session = await tx.workSession.findFirst({ where: { organizationId: ctx.orgId, id: workSessionId, userId: ctx.userId } });
          if (!session) throw new NotFoundError('Work session not found');
          if (!session.endedAt) throw new BusinessRuleError('Clock out before correcting this session');
        }
        if (kind !== 'DELETE') {
          validateInterval(new Date(proposedStartAt), new Date(proposedEndAt), now);
          await assertNoOverlap(tx, ctx.orgId, ctx.userId, new Date(proposedStartAt), new Date(proposedEndAt), session?.id);
        }
        const pending = await tx.attendanceCorrection.findFirst({
          where: { organizationId: ctx.orgId, userId: ctx.userId, status: 'PENDING', ...(session ? { workSessionId: session.id } : { kind: 'ADD', proposedStartAt: new Date(proposedStartAt) }) },
        });
        if (pending) throw new ConflictError('A correction for this session is already pending');

        const { zone, managerUserId } = await memberCalendar(tx, ctx.orgId, ctx.userId);
        const anchor = session?.startedAt ?? new Date(proposedStartAt);
        const correction = await tx.attendanceCorrection.create({
          data: {
            organizationId: ctx.orgId,
            userId: ctx.userId,
            attendanceRecordId: session?.attendanceRecordId ?? null,
            workDate: dateOnly(localDate(anchor, zone)),
            kind,
            workSessionId: session?.id ?? null,
            proposedStartAt: kind === 'DELETE' ? null : new Date(proposedStartAt),
            proposedEndAt: kind === 'DELETE' ? null : new Date(proposedEndAt),
            original: session ? { startedAt: session.startedAt, endedAt: session.endedAt } : undefined,
            reason,
          },
        });
        await recordAudit(tx, ctx, { action: 'attendance.correction_requested', targetType: 'attendance_correction', targetId: correction.id, diff: { kind } });
        if (await memberCanActOn(tx, ctx.orgId, managerUserId, 'attendance.correct.approve', ctx.userId)) {
          await notify(tx, ctx, {
            cipher,
            appOrigin: env.APP_ORIGIN,
            organizationId: ctx.orgId,
            recipientUserId: managerUserId,
            type: 'attendance.correction_requested',
            title: `${ctx.user.name} requested an attendance correction`,
            body: reason,
            link: '/attendance?tab=corrections',
            subjectType: 'attendance_correction',
            subjectId: correction.id,
            dedupeKey: `correction-requested:${correction.id}`,
          });
        }
        return serializeCorrection(correction);
      });
    },

    async listCorrections(ctx, { mine, status }) {
      let where = { organizationId: ctx.orgId, ...(status ? { status } : {}) };
      if (mine === 'true') where.userId = ctx.userId;
      else {
        const scope = await resolveMemberScope(prisma, ctx, 'attendance.correct.approve');
        if (!scope.all) where.userId = { in: [...scope.userIds].filter((id) => id !== ctx.userId) };
        else where = { ...where, userId: { not: ctx.userId } };
      }
      const rows = await prisma.attendanceCorrection.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200 });
      const map = await people(ctx.orgId, rows.map((r) => r.userId));
      return rows.map((r) => serializeCorrection(r, map));
    },

    async decideCorrection(ctx, correctionId, { decision, comment }) {
      return withTransaction(prisma, async (tx) => {
        const correction = await tx.attendanceCorrection.findFirst({ where: { organizationId: ctx.orgId, id: correctionId } });
        if (!correction) throw new NotFoundError('Correction not found');
        if (correction.userId === ctx.userId) throw new ForbiddenError('You cannot approve your own correction');
        if (!(await coversMember(tx, ctx, 'attendance.correct.approve', correction.userId))) throw new ForbiddenError();
        const { count } = await tx.attendanceCorrection.updateMany({
          where: { organizationId: ctx.orgId, id: correctionId, status: 'PENDING' },
          data: { status: decision, reviewedById: ctx.userId, reviewedAt: clock.now(), reviewComment: comment ?? null },
        });
        if (count !== 1) throw new ConflictError('This correction was already decided', ERROR_CODES.INVALID_STATE_TRANSITION);

        if (decision === 'APPROVED') {
          await applyCorrection(tx, ctx, correction);
          // The work date spans up to two UTC dates; mark the whole local day plus the corrected times.
          const day = correction.workDate.getTime();
          await recordActivity(tx, { organizationId: ctx.orgId, userId: correction.userId, type: 'attendance.corrected', occurredAt: clock.now(), subjectType: 'attendance_correction', subjectId: correctionId, metadata: { actorId: ctx.userId }, affects: [new Date(day - 86_400_000), new Date(day), new Date(day + 86_400_000), correction.proposedStartAt, correction.proposedEndAt] });
        }
        await recordAudit(tx, ctx, { action: `attendance.correction_${decision.toLowerCase()}`, targetType: 'attendance_correction', targetId: correctionId, diff: { comment } });
        await notify(tx, ctx, {
          cipher,
          appOrigin: env.APP_ORIGIN,
          organizationId: ctx.orgId,
          recipientUserId: correction.userId,
          type: 'attendance.correction_decided',
          title: `Your attendance correction was ${decision.toLowerCase()}`,
          body: comment ?? null,
          link: '/attendance',
          subjectType: 'attendance_correction',
          subjectId: correctionId,
          dedupeKey: `correction-decided:${correctionId}`,
        });
        return { id: correctionId, status: decision };
      });
    },

    async cancelCorrection(ctx, correctionId) {
      const { count } = await prisma.attendanceCorrection.updateMany({
        where: { organizationId: ctx.orgId, id: correctionId, userId: ctx.userId, status: 'PENDING' },
        data: { status: 'CANCELLED' },
      });
      if (count !== 1) throw new NotFoundError('Pending correction not found');
    },

    // ─── schedules & holidays ─────────────────────────────────────────────

    async listSchedules(ctx) {
      const schedules = await prisma.workSchedule.findMany({
        where: { organizationId: ctx.orgId, archivedAt: null },
        include: { assignments: true },
        orderBy: { name: 'asc' },
      });
      return schedules.map(({ assignments, ...s }) => ({ ...s, assignments: assignments.map((a) => ({ targetType: a.targetType, targetId: a.targetId })) }));
    },

    async saveSchedule(ctx, scheduleId, body) {
      return withTransaction(prisma, async (tx) => {
        if (body.isDefault) {
          await tx.workSchedule.updateMany({ where: { organizationId: ctx.orgId, isDefault: true }, data: { isDefault: false } });
        }
        let schedule;
        if (scheduleId) {
          const { count } = await tx.workSchedule.updateMany({ where: { organizationId: ctx.orgId, id: scheduleId, archivedAt: null }, data: body });
          if (count !== 1) throw new NotFoundError('Schedule not found');
          schedule = await tx.workSchedule.findFirst({ where: { organizationId: ctx.orgId, id: scheduleId } });
        } else {
          schedule = await tx.workSchedule.create({ data: { organizationId: ctx.orgId, ...body } });
        }
        await recordAudit(tx, ctx, { action: scheduleId ? 'attendance.schedule_updated' : 'attendance.schedule_created', targetType: 'work_schedule', targetId: schedule.id, diff: body });
        return schedule;
      });
    },

    async archiveSchedule(ctx, scheduleId) {
      await withTransaction(prisma, async (tx) => {
        const { count } = await tx.workSchedule.updateMany({ where: { organizationId: ctx.orgId, id: scheduleId, archivedAt: null }, data: { archivedAt: clock.now(), isDefault: false } });
        if (count !== 1) throw new NotFoundError('Schedule not found');
        await tx.scheduleAssignment.deleteMany({ where: { organizationId: ctx.orgId, scheduleId } });
        await recordAudit(tx, ctx, { action: 'attendance.schedule_archived', targetType: 'work_schedule', targetId: scheduleId });
      });
    },

    async assignSchedule(ctx, scheduleId, { targetType, targetId }) {
      return withTransaction(prisma, async (tx) => {
        const schedule = await tx.workSchedule.findFirst({ where: { organizationId: ctx.orgId, id: scheduleId, archivedAt: null } });
        if (!schedule) throw new NotFoundError('Schedule not found');
        let resolvedId = targetId;
        if (targetType === 'MEMBER') resolvedId = (await memberByEmployeeId(ctx.orgId, targetId)).userId;
        else {
          const model = targetType === 'TEAM' ? tx.team : tx.department;
          if (!(await model.findFirst({ where: { organizationId: ctx.orgId, id: targetId } }))) throw new ValidationError([{ path: 'body.targetId', message: 'Target not found' }]);
        }
        await tx.scheduleAssignment.upsert({
          where: { organizationId_targetType_targetId: { organizationId: ctx.orgId, targetType, targetId: resolvedId } },
          update: { scheduleId },
          create: { organizationId: ctx.orgId, scheduleId, targetType, targetId: resolvedId },
        });
        await recordAudit(tx, ctx, { action: 'attendance.schedule_assigned', targetType: 'work_schedule', targetId: scheduleId, diff: { targetType, targetId } });
        return { scheduleId, targetType, targetId };
      });
    },

    async listHolidays(ctx, { year }) {
      const rows = await prisma.holiday.findMany({
        where: { organizationId: ctx.orgId, date: { gte: dateOnly(`${year}-01-01`), lte: dateOnly(`${year}-12-31`) } },
        orderBy: { date: 'asc' },
      });
      return rows.map((h) => ({ id: h.id, date: isoDate(h.date), name: h.name, isHalfDay: h.isHalfDay }));
    },

    async createHoliday(ctx, { date, name, isHalfDay }) {
      const holiday = await prisma.holiday.create({ data: { organizationId: ctx.orgId, date: dateOnly(date), name, isHalfDay } });
      await recordAudit(prisma, ctx, { action: 'attendance.holiday_created', targetType: 'holiday', targetId: holiday.id, diff: { date, name } });
      return { id: holiday.id, date, name, isHalfDay };
    },

    async deleteHoliday(ctx, holidayId) {
      const { count } = await prisma.holiday.deleteMany({ where: { organizationId: ctx.orgId, id: holidayId } });
      if (count !== 1) throw new NotFoundError('Holiday not found');
      await recordAudit(prisma, ctx, { action: 'attendance.holiday_deleted', targetType: 'holiday', targetId: holidayId });
    },
  };
}

/** Applies an approved correction. Originals stay on the correction row; the record is marked CORRECTED. */
async function applyCorrection(tx, ctx, correction) {
  const organizationId = ctx.orgId;
  let recordId = correction.attendanceRecordId;
  if (correction.kind === 'ADD') {
    const record = await recordForInstant(tx, organizationId, correction.userId, correction.proposedStartAt);
    recordId = record.id;
    await tx.workSession.create({
      data: {
        organizationId,
        userId: correction.userId,
        attendanceRecordId: record.id,
        startedAt: correction.proposedStartAt,
        endedAt: correction.proposedEndAt,
        endReason: 'CORRECTION',
        source: 'CORRECTION',
      },
    });
  } else if (correction.kind === 'MODIFY') {
    await tx.workSession.update({
      where: { organizationId_id: { organizationId, id: correction.workSessionId } },
      data: { startedAt: correction.proposedStartAt, endedAt: correction.proposedEndAt, endReason: 'CORRECTION' },
    });
    await tx.breakSession.deleteMany({
      where: { organizationId, workSessionId: correction.workSessionId, OR: [{ startedAt: { lt: correction.proposedStartAt } }, { endedAt: { gt: correction.proposedEndAt } }] },
    });
  } else {
    // Entries keep their time but lose the link to the removed session.
    await tx.timeEntry.updateMany({ where: { organizationId, workSessionId: correction.workSessionId }, data: { workSessionId: null } });
    await tx.workSession.deleteMany({ where: { organizationId, id: correction.workSessionId } });
  }
  const record = await tx.attendanceRecord.findFirst({ where: { organizationId, id: recordId } });
  await tx.attendanceRecord.update({
    where: { organizationId_id: { organizationId, id: recordId } },
    data: { flags: [...new Set([...(record.flags ?? []), 'CORRECTED'])] },
  });
  await recomputeRecord(tx, organizationId, recordId, ctx.orgSettings?.attendance);
}
