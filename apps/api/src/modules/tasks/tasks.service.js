import { DateTime } from 'luxon';
import { ERROR_CODES } from '@orbit/shared-constants';
import { BusinessRuleError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { dateOnly, isoDate, secondsBetween } from '../../utils/time.js';
import { recordAudit } from '../../services/audit.js';
import { markStatsDirty, recordActivity } from '../activity/activity.js';
import { withTransaction } from '../../repositories/tx.js';
import { hasPermission } from '../rbac/rbac.service.js';
import { memberSummaries, resolveEmployeeUserIds } from '../shared/members.js';
import { notify } from '../notifications/notifications.service.js';
import { loadProject, readableProjectsWhere } from '../projects/access.js';
import { emitWebhookEvent } from '../integrations/webhooks.service.js';

const OPEN = ['TODO', 'IN_PROGRESS'];
const FINISHED = ['DONE', 'CANCELLED'];
const SORT_STEP = 1024;
const MAX_LIST = 500;

const taskInclude = {
  status: true,
  assignees: { select: { userId: true } },
  labels: { include: { label: true } },
  milestone: { select: { id: true, name: true } },
  project: { select: { id: true, code: true, name: true } },
  _count: { select: { subtasks: true, comments: { where: { deletedAt: null } }, checklist: true } },
};

function nextDate(iso, recurrence) {
  if (!iso) return null;
  const unit = { DAILY: 'days', WEEKLY: 'weeks', MONTHLY: 'months' }[recurrence.frequency];
  return DateTime.fromISO(iso, { zone: 'UTC' }).plus({ [unit]: recurrence.interval ?? 1 }).toISODate();
}

export function createTaskService({ prisma, clock, cipher, env, fileService }) {
  async function people(organizationId, userIds) {
    return memberSummaries(prisma, organizationId, userIds);
  }

  function summarize(t, peopleMap) {
    return {
      id: t.id,
      key: `${t.project.code}-${t.number}`,
      number: t.number,
      project: t.project,
      parentId: t.parentId,
      title: t.title,
      status: { id: t.status.id, name: t.status.name, category: t.status.category },
      priority: t.priority,
      startDate: t.startDate ? isoDate(t.startDate) : null,
      dueDate: t.dueDate ? isoDate(t.dueDate) : null,
      estimatedS: t.estimatedS,
      milestone: t.milestone,
      assignees: t.assignees.map((a) => peopleMap.get(a.userId)).filter(Boolean),
      labels: t.labels.map((l) => ({ id: l.label.id, name: l.label.name, color: l.label.color })),
      recurrence: t.recurrence,
      sort: t.sort,
      completedAt: t.completedAt,
      archivedAt: t.archivedAt,
      counts: { subtasks: t._count.subtasks, comments: t._count.comments, checklist: t._count.checklist },
      version: t.version,
    };
  }

  async function loadTask(db, ctx, taskId, need = 'canReadTasks') {
    const task = await db.task.findFirst({ where: { organizationId: ctx.orgId, id: taskId } });
    if (!task) throw new NotFoundError('Task not found');
    const { project, access } = await loadProject(db, ctx, task.projectId, 'canRead');
    if (!access.canReadTasks) throw new NotFoundError('Task not found');
    if (!access[need]) {
      // Assignees may update their own tasks even without general edit rights on the project.
      const assigned = need === 'canEditTasks' && hasPermission(ctx, 'tasks.update') && (await db.taskAssignee.findFirst({ where: { organizationId: ctx.orgId, taskId, userId: ctx.userId } }));
      if (!assigned) throw new ForbiddenError();
    }
    return { task, project, access };
  }

  // Task events that also belong in the actor's activity timeline.
  const ACTIVITY_FOR_EVENT = { created: 'task.created', status_changed: 'task.status_changed', commented: 'task.commented' };

  async function event(tx, ctx, taskId, type, data, { projectId = null, completed = false } = {}) {
    await tx.taskEvent.create({ data: { organizationId: ctx.orgId, taskId, actorId: ctx.userId ?? null, type, data: data ?? undefined } });
    const activityType = completed ? 'task.completed' : ACTIVITY_FOR_EVENT[type];
    if (activityType && ctx.userId) {
      await recordActivity(tx, { organizationId: ctx.orgId, userId: ctx.userId, type: activityType, occurredAt: clock.now(), subjectType: 'task', subjectId: taskId, projectId, metadata: data ?? null });
    }
  }

  /** Assignees must be active project members who are not viewers. */
  async function resolveAssignees(tx, ctx, projectId, employeeIds) {
    const ids = await resolveEmployeeUserIds(tx, ctx.orgId, employeeIds, 'body.assigneeEmployeeIds');
    const userIds = [...new Set(ids.values())];
    if (!userIds.length) return [];
    const members = await tx.projectMember.findMany({ where: { organizationId: ctx.orgId, projectId, userId: { in: userIds }, role: { in: ['MANAGER', 'MEMBER'] } } });
    if (members.length !== userIds.length) {
      throw new ValidationError([{ path: 'body.assigneeEmployeeIds', message: 'Tasks can only be assigned to project members (not viewers)' }]);
    }
    return userIds;
  }

  async function notifyAssigned(tx, ctx, task, project, userIds) {
    for (const userId of userIds) {
      if (userId === ctx.userId) continue;
      await notify(tx, ctx, {
        cipher,
        appOrigin: env.APP_ORIGIN,
        organizationId: ctx.orgId,
        recipientUserId: userId,
        type: 'tasks.assigned',
        title: `${ctx.user?.name ?? 'Someone'} assigned you ${project.code}-${task.number}`,
        body: task.title,
        link: `/tasks/${task.id}`,
        subjectType: 'task',
        subjectId: task.id,
        dedupeKey: `task-assigned:${task.id}:${userId}:${ctx.requestId}`,
      });
    }
  }

  async function assertSameProject(tx, ctx, projectId, { milestoneId, parentId, statusId }) {
    if (statusId && !(await tx.taskStatus.findFirst({ where: { organizationId: ctx.orgId, projectId, id: statusId } }))) {
      throw new ValidationError([{ path: 'body.statusId', message: 'Status not found in this project' }]);
    }
    if (milestoneId && !(await tx.milestone.findFirst({ where: { organizationId: ctx.orgId, projectId, id: milestoneId } }))) {
      throw new ValidationError([{ path: 'body.milestoneId', message: 'Milestone not found in this project' }]);
    }
    if (parentId) {
      const parent = await tx.task.findFirst({ where: { organizationId: ctx.orgId, projectId, id: parentId, archivedAt: null } });
      if (!parent) throw new ValidationError([{ path: 'body.parentId', message: 'Parent task not found in this project' }]);
      if (parent.parentId) throw new ValidationError([{ path: 'body.parentId', message: 'Subtasks cannot have their own subtasks' }]);
    }
  }

  async function blockers(tx, ctx, taskId) {
    const deps = await tx.taskDependency.findMany({
      where: { organizationId: ctx.orgId, taskId },
      include: { dependsOn: { select: { id: true, number: true, title: true, archivedAt: true, status: { select: { category: true } }, project: { select: { code: true } } } } },
    });
    return deps.map((d) => d.dependsOn).filter((t) => !t.archivedAt && !FINISHED.includes(t.status.category));
  }

  async function createRecord(tx, ctx, project, body) {
    // Lock the project row: task numbers are sequential per project.
    await tx.$queryRaw`SELECT id FROM projects WHERE organization_id = ${ctx.orgId} AND id = ${project.id} FOR UPDATE`;
    const { nextTaskNumber } = await tx.project.findFirst({ where: { organizationId: ctx.orgId, id: project.id }, select: { nextTaskNumber: true } });
    const statusId =
      body.statusId ??
      (await tx.taskStatus.findFirst({ where: { organizationId: ctx.orgId, projectId: project.id, category: 'TODO' }, orderBy: { sort: 'asc' } }))?.id ??
      (await tx.taskStatus.findFirst({ where: { organizationId: ctx.orgId, projectId: project.id }, orderBy: { sort: 'asc' } })).id;
    const last = await tx.task.findFirst({ where: { organizationId: ctx.orgId, projectId: project.id, statusId }, orderBy: { sort: 'desc' }, select: { sort: true } });
    const status = await tx.taskStatus.findFirst({ where: { organizationId: ctx.orgId, id: statusId } });
    const task = await tx.task.create({
      data: {
        organizationId: ctx.orgId,
        projectId: project.id,
        number: nextTaskNumber,
        parentId: body.parentId ?? null,
        milestoneId: body.milestoneId ?? null,
        statusId,
        title: body.title,
        description: body.description ?? null,
        priority: body.priority ?? 'MEDIUM',
        startDate: body.startDate ? dateOnly(body.startDate) : null,
        dueDate: body.dueDate ? dateOnly(body.dueDate) : null,
        estimatedS: body.estimatedS ?? null,
        recurrence: body.recurrence ?? undefined,
        sort: (last?.sort ?? 0) + SORT_STEP,
        completedAt: status.category === 'DONE' ? clock.now() : null,
        createdById: ctx.userId ?? null,
      },
    });
    await tx.project.updateMany({ where: { organizationId: ctx.orgId, id: project.id }, data: { nextTaskNumber: nextTaskNumber + 1 } });
    return task;
  }

  /** On completing a recurring task, the next occurrence is created with dates moved forward. */
  async function spawnRecurrence(tx, ctx, task, project) {
    const assignees = await tx.taskAssignee.findMany({ where: { organizationId: ctx.orgId, taskId: task.id } });
    const labels = await tx.taskLabel.findMany({ where: { organizationId: ctx.orgId, taskId: task.id } });
    const next = await createRecord(tx, ctx, project, {
      title: task.title,
      description: task.description,
      priority: task.priority,
      milestoneId: task.milestoneId,
      estimatedS: task.estimatedS,
      recurrence: task.recurrence,
      startDate: nextDate(task.startDate ? isoDate(task.startDate) : null, task.recurrence),
      dueDate: nextDate(task.dueDate ? isoDate(task.dueDate) : isoDate(clock.now()), task.recurrence),
    });
    if (assignees.length) await tx.taskAssignee.createMany({ data: assignees.map((a) => ({ organizationId: ctx.orgId, taskId: next.id, userId: a.userId })) });
    if (labels.length) await tx.taskLabel.createMany({ data: labels.map((l) => ({ organizationId: ctx.orgId, taskId: next.id, labelId: l.labelId })) });
    await event(tx, ctx, next.id, 'created', { recurrenceOf: task.id });
    await event(tx, ctx, task.id, 'recurred', { nextTaskId: next.id });
    return next;
  }

  async function applyUpdate(tx, ctx, task, project, patch) {
    const data = {};
    const changes = {};
    for (const field of ['title', 'description', 'priority', 'estimatedS', 'recurrence', 'sort']) {
      if (field in patch && JSON.stringify(patch[field]) !== JSON.stringify(task[field])) {
        data[field] = patch[field];
        if (field !== 'sort') changes[field] = { from: task[field], to: patch[field] };
      }
    }
    for (const field of ['startDate', 'dueDate']) {
      if (field in patch) {
        const current = task[field] ? isoDate(task[field]) : null;
        if (current !== patch[field]) {
          data[field] = patch[field] ? dateOnly(patch[field]) : null;
          changes[field] = { from: current, to: patch[field] };
        }
      }
    }
    if ('milestoneId' in patch && patch.milestoneId !== task.milestoneId) {
      await assertSameProject(tx, ctx, project.id, { milestoneId: patch.milestoneId });
      data.milestoneId = patch.milestoneId;
      changes.milestoneId = { from: task.milestoneId, to: patch.milestoneId };
    }
    let completed = false;
    if (patch.statusId && patch.statusId !== task.statusId) {
      await assertSameProject(tx, ctx, project.id, { statusId: patch.statusId });
      const [from, to] = await Promise.all([
        tx.taskStatus.findFirst({ where: { organizationId: ctx.orgId, id: task.statusId } }),
        tx.taskStatus.findFirst({ where: { organizationId: ctx.orgId, id: patch.statusId } }),
      ]);
      if (['IN_PROGRESS', 'DONE'].includes(to.category)) {
        const open = await blockers(tx, ctx, task.id);
        if (open.length) {
          throw new ConflictError(`Blocked by ${open.map((b) => `${b.project.code}-${b.number}`).join(', ')}`, 'TASK_BLOCKED', open.map((b) => ({ path: 'statusId', message: `${b.project.code}-${b.number} ${b.title}` })));
        }
      }
      data.statusId = to.id;
      if (to.category === 'DONE' && from.category !== 'DONE') {
        data.completedAt = clock.now();
        completed = true;
      } else if (to.category !== 'DONE') data.completedAt = null;
      changes.status = { from: from.name, to: to.name };
    }
    if (!Object.keys(data).length) return { task, completed: false };
    const updated = await tx.task.update({ where: { organizationId_id: { organizationId: ctx.orgId, id: task.id } }, data: { ...data, version: { increment: 1 } } });
    if (Object.keys(changes).length) await event(tx, ctx, task.id, changes.status ? 'status_changed' : 'updated', changes, { projectId: project.id, completed });
    if ('completedAt' in data) {
      // Completed-task counts belong to the assignees' days.
      const assignees = await tx.taskAssignee.findMany({ where: { organizationId: ctx.orgId, taskId: task.id }, select: { userId: true } });
      for (const a of assignees) await markStatsDirty(tx, ctx.orgId, a.userId, [clock.now(), task.completedAt]);
    }
    if (completed && task.recurrence) await spawnRecurrence(tx, ctx, updated, project);
    if (completed) await emitWebhookEvent(tx, { organizationId: ctx.orgId, type: 'task.completed', data: { taskId: task.id, projectId: project.id, key: `${project.code}-${task.number}` } });
    return { task: updated, completed };
  }

  return {
    async list(ctx, query) {
      if (!hasPermission(ctx, 'tasks.read') && !hasPermission(ctx, 'projects.manage')) throw new ForbiddenError();
      const where = { organizationId: ctx.orgId, ...(query.includeArchived === 'true' ? {} : { archivedAt: null }) };
      if (query.projectId) {
        const { access } = await loadProject(prisma, ctx, query.projectId);
        if (!access.canReadTasks) throw new NotFoundError('Project not found');
        where.projectId = query.projectId;
      } else {
        where.project = { ...readableProjectsWhere(ctx), archivedAt: null };
      }
      if (query.assignee === 'me') where.assignees = { some: { userId: ctx.userId } };
      else if (query.assignee) {
        const ids = await resolveEmployeeUserIds(prisma, ctx.orgId, [query.assignee], 'query.assignee');
        where.assignees = { some: { userId: ids.get(query.assignee) } };
      }
      if (query.statusCategory) where.status = { category: { in: query.statusCategory.split(',') } };
      if (query.statusId) where.statusId = query.statusId;
      if (query.milestoneId) where.milestoneId = query.milestoneId;
      if (query.labelId) where.labels = { some: { labelId: query.labelId } };
      if (query.parentId === 'none') where.parentId = null;
      else if (query.parentId) where.parentId = query.parentId;
      if (query.q) where.title = { contains: query.q };
      if (query.dueFrom || query.dueTo) where.dueDate = { ...(query.dueFrom ? { gte: dateOnly(query.dueFrom) } : {}), ...(query.dueTo ? { lte: dateOnly(query.dueTo) } : {}) };
      const orderBy =
        query.sort === 'dueDate'
          ? [{ dueDate: { sort: 'asc', nulls: 'last' } }, { number: 'asc' }]
          : query.sort === 'priority'
            ? [{ priority: 'desc' }, { number: 'asc' }]
            : query.sort === '-createdAt'
              ? [{ createdAt: 'desc' }]
              : [{ sort: 'asc' }, { number: 'asc' }];
      const rows = await prisma.task.findMany({ where, include: taskInclude, orderBy, take: MAX_LIST + 1 });
      const map = await people(ctx.orgId, rows.flatMap((t) => t.assignees.map((a) => a.userId)));
      return { items: rows.slice(0, MAX_LIST).map((t) => summarize(t, map)), truncated: rows.length > MAX_LIST };
    },

    async get(ctx, taskId) {
      const { task, access } = await loadTask(prisma, ctx, taskId);
      const full = await prisma.task.findFirst({
        where: { organizationId: ctx.orgId, id: taskId },
        include: {
          ...taskInclude,
          checklist: { orderBy: { sort: 'asc' } },
          comments: { where: { deletedAt: null }, orderBy: { createdAt: 'asc' } },
          attachments: { include: { file: true } },
          subtasks: { where: { archivedAt: null }, include: { status: true }, orderBy: { number: 'asc' } },
          dependencies: { include: { dependsOn: { select: { id: true, number: true, title: true, status: { select: { name: true, category: true } } } } } },
          dependents: { include: { task: { select: { id: true, number: true, title: true, status: { select: { name: true, category: true } } } } } },
          events: { orderBy: { createdAt: 'desc' }, take: 50 },
          parent: { select: { id: true, number: true, title: true } },
        },
      });
      const entries = await prisma.timeEntry.findMany({ where: { organizationId: ctx.orgId, taskId, deletedAt: null }, select: { durationS: true, endedAt: true, startedAt: true } });
      const now = clock.now();
      const map = await people(ctx.orgId, [
        ...full.assignees.map((a) => a.userId),
        ...full.comments.map((c) => c.authorId),
        ...full.events.map((e) => e.actorId),
        full.createdById,
      ]);
      const assigned = full.assignees.some((a) => a.userId === ctx.userId);
      const code = full.project.code;
      return {
        ...summarize(full, map),
        description: full.description,
        createdBy: full.createdById ? (map.get(full.createdById) ?? null) : null,
        createdAt: full.createdAt,
        parent: full.parent ? { ...full.parent, key: `${code}-${full.parent.number}` } : null,
        checklist: full.checklist.map((c) => ({ id: c.id, text: c.text, done: Boolean(c.doneAt), sort: c.sort })),
        comments: full.comments.map((c) => ({ id: c.id, author: map.get(c.authorId) ?? null, body: c.body, editedAt: c.editedAt, createdAt: c.createdAt, mine: c.authorId === ctx.userId })),
        attachments: full.attachments.filter((a) => a.file.status === 'READY').map((a) => fileService.serialize(a.file)),
        subtasks: full.subtasks.map((s) => ({ id: s.id, key: `${code}-${s.number}`, title: s.title, status: { name: s.status.name, category: s.status.category } })),
        dependsOn: full.dependencies.map((d) => ({ ...d.dependsOn, key: `${code}-${d.dependsOn.number}` })),
        blocks: full.dependents.map((d) => ({ ...d.task, key: `${code}-${d.task.number}` })),
        trackedS: entries.reduce((s, e) => s + (e.endedAt ? e.durationS : secondsBetween(e.startedAt, now)), 0),
        history: full.events.map((e) => ({ type: e.type, actor: e.actorId ? (map.get(e.actorId) ?? null) : null, data: e.data, createdAt: e.createdAt })),
        access: {
          canEdit: access.canEditTasks || (assigned && hasPermission(ctx, 'tasks.update')),
          canManage: access.canManage,
          canComment: access.canEditTasks || assigned || access.canManage,
        },
        projectRole: access.role,
        lockedReason: task.archivedAt ? 'archived' : null,
      };
    },

    async create(ctx, body) {
      const { project, access } = await loadProject(prisma, ctx, body.projectId, 'canRead');
      if (!access.canCreateTasks) throw new ForbiddenError('You cannot create tasks in this project');
      if (project.archivedAt) throw new BusinessRuleError('Restore the project before adding tasks');
      const id = await withTransaction(prisma, async (tx) => {
        await assertSameProject(tx, ctx, project.id, body);
        const assignees = await resolveAssignees(tx, ctx, project.id, body.assigneeEmployeeIds ?? []);
        const task = await createRecord(tx, ctx, project, body);
        if (assignees.length) await tx.taskAssignee.createMany({ data: assignees.map((userId) => ({ organizationId: ctx.orgId, taskId: task.id, userId })) });
        if (body.labelIds?.length) await setLabelsTx(tx, ctx, task.id, body.labelIds);
        await event(tx, ctx, task.id, 'created', { title: task.title });
        await notifyAssigned(tx, ctx, task, project, assignees);
        return task.id;
      });
      return this.get(ctx, id);
    },

    async update(ctx, taskId, { version, ...patch }) {
      const { task, project } = await loadTask(prisma, ctx, taskId, 'canEditTasks');
      if (task.archivedAt) throw new BusinessRuleError('Restore the task before editing it');
      await withTransaction(prisma, async (tx) => {
        const current = await tx.task.findFirst({ where: { organizationId: ctx.orgId, id: taskId } });
        if (version !== undefined && version !== current.version) throw new ConflictError('This task changed since you loaded it', ERROR_CODES.VERSION_CONFLICT);
        await applyUpdate(tx, ctx, current, project, patch);
      });
      return this.get(ctx, taskId);
    },

    async archive(ctx, taskId) {
      const { task } = await loadTask(prisma, ctx, taskId, 'canEditTasks');
      if (task.archivedAt) return;
      await withTransaction(prisma, async (tx) => {
        const now = clock.now();
        await tx.task.updateMany({ where: { organizationId: ctx.orgId, OR: [{ id: taskId }, { parentId: taskId }] }, data: { archivedAt: now } });
        await event(tx, ctx, taskId, 'archived');
        await recordAudit(tx, ctx, { action: 'tasks.archived', targetType: 'task', targetId: taskId });
      });
    },

    async restore(ctx, taskId) {
      const { task } = await loadTask(prisma, ctx, taskId, 'canEditTasks');
      if (!task.archivedAt) throw new ConflictError('The task is not archived', ERROR_CODES.INVALID_STATE_TRANSITION);
      await prisma.task.updateMany({ where: { organizationId: ctx.orgId, id: taskId }, data: { archivedAt: null } });
      await event(prisma, ctx, taskId, 'restored');
      return this.get(ctx, taskId);
    },

    /** Applies one change to many tasks of one project; all or nothing. */
    async bulk(ctx, { taskIds, action, value }) {
      const tasks = await prisma.task.findMany({ where: { organizationId: ctx.orgId, id: { in: taskIds }, archivedAt: null } });
      if (tasks.length !== new Set(taskIds).size) throw new ValidationError([{ path: 'body.taskIds', message: 'Some tasks were not found or are archived' }]);
      const projectIds = new Set(tasks.map((t) => t.projectId));
      if (projectIds.size !== 1) throw new ValidationError([{ path: 'body.taskIds', message: 'Bulk changes apply to tasks of one project at a time' }]);
      const { project, access } = await loadProject(prisma, ctx, [...projectIds][0], 'canRead');
      if (!access.canEditTasks) throw new ForbiddenError();
      await withTransaction(prisma, async (tx) => {
        for (const t of tasks) {
          if (action === 'archive') {
            await tx.task.updateMany({ where: { organizationId: ctx.orgId, OR: [{ id: t.id }, { parentId: t.id }] }, data: { archivedAt: clock.now() } });
            await event(tx, ctx, t.id, 'archived');
          } else if (action === 'assign') {
            const [userId] = await resolveAssignees(tx, ctx, project.id, [value]);
            await tx.taskAssignee.createMany({ data: [{ organizationId: ctx.orgId, taskId: t.id, userId }], skipDuplicates: true });
            await event(tx, ctx, t.id, 'assigned', { added: [userId] });
            await notifyAssigned(tx, ctx, t, project, [userId]);
          } else {
            const current = await tx.task.findFirst({ where: { organizationId: ctx.orgId, id: t.id } });
            await applyUpdate(tx, ctx, current, project, action === 'status' ? { statusId: value } : { priority: value });
          }
        }
        await recordAudit(tx, ctx, { action: `tasks.bulk_${action}`, targetType: 'project', targetId: project.id, diff: { count: tasks.length, value } });
      });
      return { updated: tasks.length };
    },

    async setAssignees(ctx, taskId, employeeIds) {
      const { task, project } = await loadTask(prisma, ctx, taskId, 'canEditTasks');
      await withTransaction(prisma, async (tx) => {
        const userIds = await resolveAssignees(tx, ctx, project.id, employeeIds);
        const before = (await tx.taskAssignee.findMany({ where: { organizationId: ctx.orgId, taskId } })).map((a) => a.userId);
        await tx.taskAssignee.deleteMany({ where: { organizationId: ctx.orgId, taskId } });
        if (userIds.length) await tx.taskAssignee.createMany({ data: userIds.map((userId) => ({ organizationId: ctx.orgId, taskId, userId })) });
        const added = userIds.filter((u) => !before.includes(u));
        const removed = before.filter((u) => !userIds.includes(u));
        if (added.length || removed.length) await event(tx, ctx, taskId, 'assigned', { added, removed });
        await notifyAssigned(tx, ctx, task, project, added);
      });
      return this.get(ctx, taskId);
    },

    // ─── checklist ────────────────────────────────────────────────────────

    async addChecklistItem(ctx, taskId, { text }) {
      await loadTask(prisma, ctx, taskId, 'canEditTasks');
      const last = await prisma.taskChecklistItem.findFirst({ where: { organizationId: ctx.orgId, taskId }, orderBy: { sort: 'desc' } });
      await prisma.taskChecklistItem.create({ data: { organizationId: ctx.orgId, taskId, text, sort: (last?.sort ?? -1) + 1 } });
      return this.get(ctx, taskId);
    },

    async updateChecklistItem(ctx, taskId, itemId, { text, done }) {
      await loadTask(prisma, ctx, taskId, 'canEditTasks');
      const { count } = await prisma.taskChecklistItem.updateMany({
        where: { organizationId: ctx.orgId, taskId, id: itemId },
        data: { ...(text !== undefined ? { text } : {}), ...(done !== undefined ? { doneAt: done ? clock.now() : null } : {}) },
      });
      if (count !== 1) throw new NotFoundError('Checklist item not found');
      return this.get(ctx, taskId);
    },

    async deleteChecklistItem(ctx, taskId, itemId) {
      await loadTask(prisma, ctx, taskId, 'canEditTasks');
      const { count } = await prisma.taskChecklistItem.deleteMany({ where: { organizationId: ctx.orgId, taskId, id: itemId } });
      if (count !== 1) throw new NotFoundError('Checklist item not found');
      return this.get(ctx, taskId);
    },

    // ─── labels ───────────────────────────────────────────────────────────

    listLabels(ctx) {
      return prisma.label.findMany({ where: { organizationId: ctx.orgId }, orderBy: { name: 'asc' }, select: { id: true, name: true, color: true } });
    },

    async createLabel(ctx, { name, color }) {
      return prisma.label.create({ data: { organizationId: ctx.orgId, name, color }, select: { id: true, name: true, color: true } });
    },

    async setLabels(ctx, taskId, labelIds) {
      await loadTask(prisma, ctx, taskId, 'canEditTasks');
      await withTransaction(prisma, (tx) => setLabelsTx(tx, ctx, taskId, labelIds));
      return this.get(ctx, taskId);
    },

    // ─── comments ─────────────────────────────────────────────────────────

    async addComment(ctx, taskId, { body }) {
      const { task, project, access } = await loadTask(prisma, ctx, taskId);
      const assignees = await prisma.taskAssignee.findMany({ where: { organizationId: ctx.orgId, taskId } });
      const canComment = access.canEditTasks || access.canManage || assignees.some((a) => a.userId === ctx.userId);
      if (!canComment) throw new ForbiddenError('You cannot comment on this task');
      await withTransaction(prisma, async (tx) => {
        const comment = await tx.taskComment.create({ data: { organizationId: ctx.orgId, taskId, authorId: ctx.userId, body } });
        await event(tx, ctx, taskId, 'commented', { commentId: comment.id });
        for (const a of assignees) {
          if (a.userId === ctx.userId) continue;
          await notify(tx, ctx, {
            cipher,
            appOrigin: env.APP_ORIGIN,
            organizationId: ctx.orgId,
            recipientUserId: a.userId,
            type: 'tasks.commented',
            title: `${ctx.user?.name ?? 'Someone'} commented on ${project.code}-${task.number}`,
            body: body.slice(0, 280),
            link: `/tasks/${taskId}`,
            subjectType: 'task',
            subjectId: taskId,
            dedupeKey: `task-comment:${comment.id}:${a.userId}`,
          });
        }
      });
      return this.get(ctx, taskId);
    },

    async editComment(ctx, taskId, commentId, { body }) {
      await loadTask(prisma, ctx, taskId);
      const { count } = await prisma.taskComment.updateMany({
        where: { organizationId: ctx.orgId, taskId, id: commentId, authorId: ctx.userId, deletedAt: null },
        data: { body, editedAt: clock.now() },
      });
      if (count !== 1) throw new NotFoundError('Comment not found');
      return this.get(ctx, taskId);
    },

    async deleteComment(ctx, taskId, commentId) {
      const { access } = await loadTask(prisma, ctx, taskId);
      const where = { organizationId: ctx.orgId, taskId, id: commentId, deletedAt: null, ...(access.canManage ? {} : { authorId: ctx.userId }) };
      const { count } = await prisma.taskComment.updateMany({ where, data: { deletedAt: clock.now() } });
      if (count !== 1) throw new NotFoundError('Comment not found');
      return this.get(ctx, taskId);
    },

    // ─── dependencies ─────────────────────────────────────────────────────

    async addDependency(ctx, taskId, dependsOnTaskId) {
      const { task } = await loadTask(prisma, ctx, taskId, 'canEditTasks');
      if (taskId === dependsOnTaskId) throw new ValidationError([{ path: 'body.dependsOnTaskId', message: 'A task cannot depend on itself' }]);
      await withTransaction(prisma, async (tx) => {
        const other = await tx.task.findFirst({ where: { organizationId: ctx.orgId, id: dependsOnTaskId, projectId: task.projectId, archivedAt: null } });
        if (!other) throw new ValidationError([{ path: 'body.dependsOnTaskId', message: 'Task not found in this project' }]);
        // Reject cycles: walk what `dependsOnTaskId` (transitively) depends on.
        const all = await tx.taskDependency.findMany({ where: { organizationId: ctx.orgId, task: { projectId: task.projectId } } });
        const edges = new Map();
        for (const d of all) edges.set(d.taskId, [...(edges.get(d.taskId) ?? []), d.dependsOnTaskId]);
        const stack = [dependsOnTaskId];
        const seen = new Set();
        while (stack.length) {
          const id = stack.pop();
          if (id === taskId) throw new ValidationError([{ path: 'body.dependsOnTaskId', message: 'This dependency would create a cycle' }]);
          if (seen.has(id)) continue;
          seen.add(id);
          stack.push(...(edges.get(id) ?? []));
        }
        await tx.taskDependency.createMany({ data: [{ organizationId: ctx.orgId, taskId, dependsOnTaskId }], skipDuplicates: true });
        await event(tx, ctx, taskId, 'dependency_added', { dependsOnTaskId });
      });
      return this.get(ctx, taskId);
    },

    async removeDependency(ctx, taskId, dependsOnTaskId) {
      await loadTask(prisma, ctx, taskId, 'canEditTasks');
      await prisma.taskDependency.deleteMany({ where: { organizationId: ctx.orgId, taskId, dependsOnTaskId } });
      return this.get(ctx, taskId);
    },

    // ─── attachments ──────────────────────────────────────────────────────

    async presignAttachment(ctx, taskId, body) {
      await loadTask(prisma, ctx, taskId, 'canEditTasks');
      const { file, upload } = await fileService.presignUpload(prisma, ctx, { ...body, purpose: 'task-attachments' });
      return { fileId: file.id, upload };
    },

    async completeAttachment(ctx, taskId, fileId) {
      await loadTask(prisma, ctx, taskId, 'canEditTasks');
      await withTransaction(prisma, async (tx) => {
        const file = await fileService.verifyUpload(tx, ctx, fileId);
        await tx.taskAttachment.createMany({ data: [{ organizationId: ctx.orgId, taskId, fileId }], skipDuplicates: true });
        await event(tx, ctx, taskId, 'attachment_added', { fileId, name: file.originalName });
      });
      return this.get(ctx, taskId);
    },

    async attachmentUrl(ctx, taskId, fileId) {
      await loadTask(prisma, ctx, taskId);
      const link = await prisma.taskAttachment.findFirst({ where: { organizationId: ctx.orgId, taskId, fileId }, include: { file: true } });
      if (!link || link.file.status !== 'READY') throw new NotFoundError('Attachment not found');
      await recordAudit(prisma, ctx, { action: 'files.downloaded', targetType: 'file', targetId: fileId });
      return fileService.accessUrl(link.file);
    },

    async removeAttachment(ctx, taskId, fileId) {
      await loadTask(prisma, ctx, taskId, 'canEditTasks');
      const link = await prisma.taskAttachment.findFirst({ where: { organizationId: ctx.orgId, taskId, fileId }, include: { file: true } });
      if (!link) throw new NotFoundError('Attachment not found');
      await prisma.taskAttachment.deleteMany({ where: { organizationId: ctx.orgId, taskId, fileId } });
      await fileService.remove(prisma, ctx, link.file);
      await event(prisma, ctx, taskId, 'attachment_removed', { fileId, name: link.file.originalName });
      return this.get(ctx, taskId);
    },

    /** Validates a project/task pair for time tracking: the member must be able to work on it. */
    async assertTrackable(db, ctx, { projectId, taskId }, userId = ctx.userId) {
      if (!projectId && !taskId) return {};
      let resolvedProjectId = projectId;
      if (taskId) {
        const task = await db.task.findFirst({ where: { organizationId: ctx.orgId, id: taskId, archivedAt: null } });
        if (!task || (projectId && task.projectId !== projectId)) throw new ValidationError([{ path: 'body.taskId', message: 'Task not found in this project' }]);
        resolvedProjectId = task.projectId;
      }
      const project = await db.project.findFirst({ where: { organizationId: ctx.orgId, id: resolvedProjectId, archivedAt: null } });
      if (!project) throw new ValidationError([{ path: 'body.projectId', message: 'Project not found' }]);
      const membership = await db.projectMember.findFirst({ where: { organizationId: ctx.orgId, projectId: project.id, userId, role: { in: ['MANAGER', 'MEMBER'] } } });
      if (!membership && project.managerUserId !== userId) {
        throw new ForbiddenError('Time can only be tracked on projects the person is a member of');
      }
      return { projectId: resolvedProjectId, taskId: taskId ?? null, isBillableDefault: project.isBillableDefault };
    },
  };
}

async function setLabelsTx(tx, ctx, taskId, labelIds) {
  const unique = [...new Set(labelIds)];
  const labels = await tx.label.findMany({ where: { organizationId: ctx.orgId, id: { in: unique } } });
  if (labels.length !== unique.length) throw new ValidationError([{ path: 'body.labelIds', message: 'One or more labels were not found' }]);
  await tx.taskLabel.deleteMany({ where: { organizationId: ctx.orgId, taskId } });
  if (unique.length) await tx.taskLabel.createMany({ data: unique.map((labelId) => ({ organizationId: ctx.orgId, taskId, labelId })) });
}

/**
 * Daily overdue reminders: one notification per assignee per task per local day, for open tasks
 * whose due date has passed in the organization's time zone. Idempotent through dedupe keys.
 */
export async function notifyOverdueTasks({ prisma, clock, cipher, env }) {
  const orgs = await prisma.organization.findMany({ where: { status: { in: ['TRIAL', 'ACTIVE'] } }, select: { id: true, timeZone: true } });
  let notified = 0;
  for (const org of orgs) {
    const today = DateTime.fromJSDate(clock.now(), { zone: org.timeZone }).toISODate();
    const tasks = await prisma.task.findMany({
      where: { organizationId: org.id, archivedAt: null, dueDate: { lt: dateOnly(today) }, status: { category: { in: OPEN } }, project: { archivedAt: null } },
      include: { assignees: true, project: { select: { code: true } } },
      take: 5000,
    });
    for (const task of tasks) {
      for (const a of task.assignees) {
        const created = await notify(prisma, null, {
          cipher,
          appOrigin: env.APP_ORIGIN,
          organizationId: org.id,
          recipientUserId: a.userId,
          type: 'tasks.overdue',
          title: `${task.project.code}-${task.number} is overdue`,
          body: `${task.title} was due ${isoDate(task.dueDate)}`,
          link: `/tasks/${task.id}`,
          subjectType: 'task',
          subjectId: task.id,
          dedupeKey: `task-overdue:${task.id}:${today}`,
        });
        if (created) notified += 1;
      }
    }
  }
  return { notified };
}
