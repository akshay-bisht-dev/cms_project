import { ERROR_CODES } from '@orbit/shared-constants';
import { BusinessRuleError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { localDateRange, secondsBetween } from '../../utils/time.js';
import { recordAudit } from '../../services/audit.js';
import { recordActivity } from '../activity/activity.js';
import { withTransaction } from '../../repositories/tx.js';
import { coversMember, hasPermission } from '../rbac/rbac.service.js';
import { memberCalendar } from '../attendance/schedule.js';
import { ensureWorkStateRow, lockWorkState } from '../attendance/work.service.js';

const MAX_ENTRY_S = 24 * 3600;
const SNAPSHOT_FIELDS = ['startedAt', 'endedAt', 'durationS', 'description', 'isBillable', 'projectId', 'taskId', 'deletedAt'];

const snapshot = (entry) => Object.fromEntries(SNAPSHOT_FIELDS.map((f) => [f, entry[f] ?? null]));

function serialize(e) {
  return {
    id: e.id,
    startedAt: e.startedAt,
    endedAt: e.endedAt,
    durationS: e.durationS,
    description: e.description,
    isBillable: e.isBillable,
    projectId: e.projectId,
    taskId: e.taskId,
    project: e.project ? { id: e.project.id, code: e.project.code, name: e.project.name } : null,
    task: e.task ? { id: e.task.id, key: `${e.project?.code ?? ''}-${e.task.number}`, title: e.task.title } : null,
    source: e.source,
    locked: Boolean(e.lockedAt),
    running: !e.endedAt,
    version: e.version,
  };
}

export function createTimeEntryService({ prisma, clock, taskService }) {
  /** Who may change entries for `targetUserId`: themselves (time.manual) or editors in scope. */
  async function assertCanEdit(db, ctx, targetUserId) {
    if (targetUserId === ctx.userId) {
      if (!hasPermission(ctx, 'time.manual')) throw new ForbiddenError();
      if (ctx.orgSettings?.timeTracking?.allowManualEntries === false) {
        throw new BusinessRuleError('Your organization does not allow manual time entries');
      }
      return;
    }
    if (!(await coversMember(db, ctx, 'time.edit.others', targetUserId))) throw new ForbiddenError('You cannot edit this person’s time');
  }

  async function assertNoOverlap(tx, organizationId, userId, startedAt, endedAt, excludeId) {
    const clash = await tx.timeEntry.findFirst({
      where: {
        organizationId,
        userId,
        deletedAt: null,
        ...(excludeId ? { id: { not: excludeId } } : {}),
        startedAt: { lt: endedAt },
        OR: [{ endedAt: null }, { endedAt: { gt: startedAt } }],
      },
    });
    if (clash) throw new ConflictError('This overlaps another time entry', ERROR_CODES.OVERLAP, [{ path: 'body.startedAt', message: 'Overlaps an existing entry' }]);
  }

  function validateInterval(startedAt, endedAt, now) {
    if (endedAt <= startedAt) throw new ValidationError([{ path: 'body.endedAt', message: 'The end must be after the start' }]);
    if (secondsBetween(startedAt, endedAt) > MAX_ENTRY_S) throw new ValidationError([{ path: 'body.endedAt', message: 'An entry cannot exceed 24 hours' }]);
    if (endedAt > now) throw new ValidationError([{ path: 'body.endedAt', message: 'Entries cannot end in the future' }]);
  }

  async function addRevision(tx, ctx, entry, before, after, reason) {
    const count = await tx.timeEntryRevision.count({ where: { organizationId: ctx.orgId, timeEntryId: entry.id } });
    await tx.timeEntryRevision.create({
      data: { organizationId: ctx.orgId, timeEntryId: entry.id, revisionNo: count + 1, before, after, reason: reason ?? null, changedById: ctx.userId },
    });
  }

  async function resolveTarget(ctx, employeeId) {
    if (!employeeId) return ctx.userId;
    const member = await prisma.organizationMember.findFirst({ where: { organizationId: ctx.orgId, id: employeeId } });
    if (!member) throw new NotFoundError('Employee not found');
    return member.userId;
  }

  async function findEntry(db, organizationId, id) {
    const entry = await db.timeEntry.findFirst({ where: { organizationId, id, deletedAt: null } });
    if (!entry) throw new NotFoundError('Time entry not found');
    return entry;
  }

  /**
   * All edits take the member's work-state lock first, so they serialize with the running timer
   * and with each other: overlap checks cannot race.
   */
  async function underMemberLock(organizationId, userId, fn) {
    await ensureWorkStateRow(prisma, organizationId, userId);
    return withTransaction(prisma, async (tx) => {
      await lockWorkState(tx, organizationId, userId);
      return fn(tx);
    });
  }

  return {
    async list(ctx, { from, to, employeeId }) {
      const userId = await resolveTarget(ctx, employeeId);
      if (!(await coversMember(prisma, ctx, 'time.read', userId))) throw new ForbiddenError('You cannot view this person’s time');
      const { zone } = await memberCalendar(prisma, ctx.orgId, userId);
      const [start, end] = localDateRange(from, to, zone);
      const now = clock.now();
      const entries = await prisma.timeEntry.findMany({
        where: { organizationId: ctx.orgId, userId, deletedAt: null, startedAt: { gte: start, lt: end } },
        include: { project: { select: { id: true, code: true, name: true } }, task: { select: { id: true, number: true, title: true } } },
        orderBy: { startedAt: 'desc' },
        take: 2000,
      });
      const live = (e) => (e.endedAt ? e.durationS : secondsBetween(e.startedAt, now));
      return {
        items: entries.map(serialize),
        totals: {
          trackedS: entries.reduce((s, e) => s + live(e), 0),
          billableS: entries.filter((e) => e.isBillable).reduce((s, e) => s + live(e), 0),
        },
        timeZone: zone,
      };
    },

    async create(ctx, { employeeId, startedAt, endedAt, description, isBillable, reason, projectId, taskId }) {
      const userId = await resolveTarget(ctx, employeeId);
      await assertCanEdit(prisma, ctx, userId);
      const start = new Date(startedAt);
      const end = new Date(endedAt);
      validateInterval(start, end, clock.now());
      return underMemberLock(ctx.orgId, userId, async (tx) => {
        await assertNoOverlap(tx, ctx.orgId, userId, start, end);
        const work = await taskService.assertTrackable(tx, ctx, { projectId, taskId }, userId);
        const entry = await tx.timeEntry.create({
          data: {
            organizationId: ctx.orgId,
            userId,
            startedAt: start,
            endedAt: end,
            durationS: secondsBetween(start, end),
            description: description ?? null,
            isBillable: isBillable ?? false,
            projectId: work.projectId ?? null,
            taskId: work.taskId ?? null,
            source: 'MANUAL',
          },
        });
        await addRevision(tx, ctx, entry, null, snapshot(entry), reason);
        await recordAudit(tx, ctx, { action: 'time.entry_created', targetType: 'time_entry', targetId: entry.id, diff: { forUserId: userId, startedAt, endedAt } });
        await recordActivity(tx, { organizationId: ctx.orgId, userId, type: 'time.entry_added', occurredAt: clock.now(), subjectType: 'time_entry', subjectId: entry.id, projectId: entry.projectId, metadata: { actorId: ctx.userId, startedAt: start, endedAt: end }, affects: [start, end] });
        return serialize(entry);
      });
    },

    async update(ctx, entryId, { reason, version, ...patch }) {
      const existing = await findEntry(prisma, ctx.orgId, entryId);
      await assertCanEdit(prisma, ctx, existing.userId);
      return underMemberLock(ctx.orgId, existing.userId, async (tx) => {
        const entry = await findEntry(tx, ctx.orgId, entryId);
        if (version !== undefined && version !== entry.version) throw new ConflictError('This entry changed since you loaded it', ERROR_CODES.VERSION_CONFLICT);
        if (entry.lockedAt) throw new ConflictError('This entry is in a submitted or approved timesheet', ERROR_CODES.PERIOD_LOCKED);
        if (!entry.endedAt && (patch.startedAt || patch.endedAt)) throw new BusinessRuleError('Stop the timer before changing its times');
        const start = patch.startedAt ? new Date(patch.startedAt) : entry.startedAt;
        const end = patch.endedAt ? new Date(patch.endedAt) : entry.endedAt;
        if (entry.endedAt) {
          validateInterval(start, end, clock.now());
          await assertNoOverlap(tx, ctx.orgId, entry.userId, start, end, entry.id);
        }
        let work = null;
        if ('projectId' in patch || 'taskId' in patch) {
          work = await taskService.assertTrackable(tx, ctx, { projectId: patch.projectId ?? null, taskId: patch.taskId ?? null }, entry.userId);
        }
        const updated = await tx.timeEntry.update({
          where: { organizationId_id: { organizationId: ctx.orgId, id: entryId } },
          data: {
            ...(work ? { projectId: work.projectId ?? null, taskId: work.taskId ?? null } : {}),
            ...(patch.description !== undefined ? { description: patch.description } : {}),
            ...(patch.isBillable !== undefined ? { isBillable: patch.isBillable } : {}),
            ...(entry.endedAt ? { startedAt: start, endedAt: end, durationS: secondsBetween(start, end) } : {}),
            version: { increment: 1 },
          },
        });
        await addRevision(tx, ctx, entry, snapshot(entry), snapshot(updated), reason);
        await recordAudit(tx, ctx, { action: 'time.entry_updated', targetType: 'time_entry', targetId: entryId, diff: { before: snapshot(entry), after: snapshot(updated) } });
        await recordActivity(tx, { organizationId: ctx.orgId, userId: entry.userId, type: 'time.entry_edited', occurredAt: clock.now(), subjectType: 'time_entry', subjectId: entryId, projectId: updated.projectId, metadata: { actorId: ctx.userId }, affects: [entry.startedAt, entry.endedAt, updated.startedAt, updated.endedAt] });
        return serialize(updated);
      });
    },

    async remove(ctx, entryId, { reason }) {
      const existing = await findEntry(prisma, ctx.orgId, entryId);
      await assertCanEdit(prisma, ctx, existing.userId);
      await underMemberLock(ctx.orgId, existing.userId, async (tx) => {
        const entry = await findEntry(tx, ctx.orgId, entryId);
        if (entry.lockedAt) throw new ConflictError('This entry is in a submitted or approved timesheet', ERROR_CODES.PERIOD_LOCKED);
        if (!entry.endedAt) throw new BusinessRuleError('Stop the timer before deleting this entry');
        const deleted = await tx.timeEntry.update({
          where: { organizationId_id: { organizationId: ctx.orgId, id: entryId } },
          data: { deletedAt: clock.now(), version: { increment: 1 } },
        });
        // A deleted entry never counts toward a (draft) timesheet.
        await tx.timesheetEntry.deleteMany({ where: { organizationId: ctx.orgId, timeEntryId: entryId } });
        await addRevision(tx, ctx, entry, snapshot(entry), snapshot(deleted), reason);
        await recordAudit(tx, ctx, { action: 'time.entry_deleted', targetType: 'time_entry', targetId: entryId, diff: { reason } });
        await recordActivity(tx, { organizationId: ctx.orgId, userId: entry.userId, type: 'time.entry_deleted', occurredAt: clock.now(), subjectType: 'time_entry', subjectId: entryId, projectId: entry.projectId, metadata: { actorId: ctx.userId }, affects: [entry.startedAt, entry.endedAt] });
      });
    },

    async revisions(ctx, entryId) {
      const entry = await prisma.timeEntry.findFirst({ where: { organizationId: ctx.orgId, id: entryId } });
      if (!entry || !(await coversMember(prisma, ctx, 'time.read', entry.userId))) throw new NotFoundError('Time entry not found');
      return prisma.timeEntryRevision.findMany({ where: { organizationId: ctx.orgId, timeEntryId: entryId }, orderBy: { revisionNo: 'asc' } });
    },
  };
}
