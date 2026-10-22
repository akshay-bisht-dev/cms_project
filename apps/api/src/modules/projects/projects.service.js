import { DateTime } from 'luxon';
import { ERROR_CODES } from '@orbit/shared-constants';
import { BusinessRuleError, ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { dateOnly, isoDate, secondsBetween } from '../../utils/time.js';
import { recordAudit } from '../../services/audit.js';
import { withTransaction } from '../../repositories/tx.js';
import { hasOrgScope } from '../rbac/rbac.service.js';
import { memberSummaries, resolveEmployeeUserId, resolveEmployeeUserIds } from '../shared/members.js';
import { loadProject, projectAccess, readableProjectsWhere } from './access.js';
import { emitWebhookEvent } from '../integrations/webhooks.service.js';

export const DEFAULT_STATUSES = [
  { name: 'To do', category: 'TODO' },
  { name: 'In progress', category: 'IN_PROGRESS' },
  { name: 'In review', category: 'IN_PROGRESS' },
  { name: 'Done', category: 'DONE' },
];

const DATE_FIELDS = ['startDate', 'endDate', 'deadline'];
const OPEN = ['TODO', 'IN_PROGRESS'];

function codeFromName(name) {
  const letters = name.toUpperCase().replace(/[^A-Z0-9 ]/g, '').split(/\s+/).filter(Boolean);
  const base = letters.length > 1 ? letters.map((w) => w[0]).join('') : (letters[0] ?? 'PRJ').slice(0, 4);
  return base.slice(0, 8) || 'PRJ';
}

function serialize(p, { access, people, counts } = {}) {
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    description: p.description,
    clientId: p.clientId,
    sharedWithClient: p.sharedWithClient,
    manager: p.managerUserId ? (people?.get(p.managerUserId) ?? null) : null,
    status: p.status,
    priority: p.priority,
    visibility: p.visibility,
    startDate: p.startDate ? isoDate(p.startDate) : null,
    endDate: p.endDate ? isoDate(p.endDate) : null,
    deadline: p.deadline ? isoDate(p.deadline) : null,
    estimatedS: p.estimatedS,
    isBillableDefault: p.isBillableDefault,
    // Money is visible only to people allowed to see budgets; never as a float.
    budget: access?.canSeeBudget && p.budgetAmount !== null ? { amount: p.budgetAmount.toFixed(2), currency: p.budgetCurrency } : undefined,
    closedAt: p.closedAt,
    archivedAt: p.archivedAt,
    createdAt: p.createdAt,
    taskCounts: counts,
    access: access ? { role: access.role, canManage: access.canManage, canCreateTasks: access.canCreateTasks, canEditTasks: access.canEditTasks, canSeeBudget: access.canSeeBudget } : undefined,
  };
}

export function createProjectService({ prisma, clock }) {
  async function uniqueCode(tx, organizationId, desired) {
    for (let n = 1; n < 100; n += 1) {
      const code = n === 1 ? desired : `${desired}${n}`;
      if (!(await tx.project.findFirst({ where: { organizationId, code } }))) return code;
    }
    throw new ConflictError('Could not generate a unique project code; choose one');
  }

  /** A project's client must exist in the organization. */
  async function assertClientRef(db, ctx, clientId) {
    if (!clientId) return;
    if (!(await db.client.findFirst({ where: { organizationId: ctx.orgId, id: clientId } }))) throw new ValidationError([{ path: 'body.clientId', message: 'Client not found' }]);
  }

  function toData(body) {
    const data = { ...body };
    delete data.managerEmployeeId;
    delete data.memberEmployeeIds;
    delete data.budget;
    for (const f of DATE_FIELDS) if (f in data) data[f] = data[f] ? dateOnly(data[f]) : null;
    if ('budget' in body) {
      data.budgetAmount = body.budget ? body.budget.amount : null;
      data.budgetCurrency = body.budget ? body.budget.currency : null;
    }
    return data;
  }

  async function taskCounts(db, organizationId, projectIds) {
    if (!projectIds.length) return new Map();
    const rows = await db.task.groupBy({
      by: ['projectId', 'statusId'],
      where: { organizationId, projectId: { in: projectIds }, archivedAt: null },
      _count: { _all: true },
    });
    const statuses = await db.taskStatus.findMany({ where: { organizationId, projectId: { in: projectIds } }, select: { id: true, category: true } });
    const categoryOf = new Map(statuses.map((s) => [s.id, s.category]));
    const counts = new Map();
    for (const r of rows) {
      const c = counts.get(r.projectId) ?? { total: 0, open: 0, done: 0 };
      c.total += r._count._all;
      if (OPEN.includes(categoryOf.get(r.statusId))) c.open += r._count._all;
      if (categoryOf.get(r.statusId) === 'DONE') c.done += r._count._all;
      counts.set(r.projectId, c);
    }
    return counts;
  }

  return {
    async list(ctx, { q, status, mine, includeArchived, memberEmployeeId }) {
      const where = { ...readableProjectsWhere(ctx), ...(includeArchived === 'true' ? {} : { archivedAt: null }) };
      if (status) where.status = { in: status.split(',') };
      if (q) where.AND = [{ OR: [{ name: { contains: q } }, { code: { contains: q } }] }];
      if (memberEmployeeId) {
        const userId = await resolveEmployeeUserId(prisma, ctx.orgId, memberEmployeeId, 'query.memberEmployeeId');
        where.AND = [...(where.AND ?? []), { members: { some: { userId } } }];
      }
      if (mine === 'true') where.AND = [...(where.AND ?? []), { OR: [{ managerUserId: ctx.userId }, { members: { some: { userId: ctx.userId } } }] }];
      const projects = await prisma.project.findMany({ where, orderBy: [{ status: 'asc' }, { name: 'asc' }], take: 500 });
      const [people, counts] = await Promise.all([
        memberSummaries(prisma, ctx.orgId, projects.map((p) => p.managerUserId)),
        taskCounts(prisma, ctx.orgId, projects.map((p) => p.id)),
      ]);
      return Promise.all(
        projects.map(async (p) => serialize(p, { people, counts: counts.get(p.id) ?? { total: 0, open: 0, done: 0 }, access: await projectAccess(prisma, ctx, p) })),
      );
    },

    async get(ctx, projectId) {
      const { project, access } = await loadProject(prisma, ctx, projectId);
      const [people, counts] = await Promise.all([memberSummaries(prisma, ctx.orgId, [project.managerUserId]), taskCounts(prisma, ctx.orgId, [project.id])]);
      return serialize(project, { people, access, counts: counts.get(project.id) ?? { total: 0, open: 0, done: 0 } });
    },

    async create(ctx, body) {
      return withTransaction(prisma, async (tx) => {
        const managerUserId = (await resolveEmployeeUserId(tx, ctx.orgId, body.managerEmployeeId, 'body.managerEmployeeId')) ?? ctx.userId;
        const members = await resolveEmployeeUserIds(tx, ctx.orgId, body.memberEmployeeIds ?? [], 'body.memberEmployeeIds');
        const code = body.code ? body.code : await uniqueCode(tx, ctx.orgId, codeFromName(body.name));
        await assertClientRef(tx, ctx, body.clientId);
        const project = await tx.project.create({ data: { ...toData(body), code, organizationId: ctx.orgId, managerUserId } });
        await tx.taskStatus.createMany({ data: DEFAULT_STATUSES.map((s, sort) => ({ organizationId: ctx.orgId, projectId: project.id, ...s, sort })) });
        const memberIds = new Set([managerUserId, ...members.values()]);
        await tx.projectMember.createMany({
          data: [...memberIds].map((userId) => ({ organizationId: ctx.orgId, projectId: project.id, userId, role: userId === managerUserId ? 'MANAGER' : 'MEMBER' })),
        });
        await recordAudit(tx, ctx, { action: 'projects.created', targetType: 'project', targetId: project.id, diff: { code, name: body.name } });
        await emitWebhookEvent(tx, { organizationId: ctx.orgId, type: 'project.created', data: { projectId: project.id, code: project.code, name: project.name } });
        return project.id;
      }).then((id) => this.get(ctx, id));
    },

    async update(ctx, projectId, body) {
      const { project } = await loadProject(prisma, ctx, projectId, 'canManage');
      if (project.archivedAt) throw new BusinessRuleError('Restore the project before editing it');
      await withTransaction(prisma, async (tx) => {
        await assertClientRef(tx, ctx, body.clientId);
        const data = toData(body);
        if ('managerEmployeeId' in body) {
          data.managerUserId = await resolveEmployeeUserId(tx, ctx.orgId, body.managerEmployeeId, 'body.managerEmployeeId');
          if (data.managerUserId) {
            const where = { organizationId: ctx.orgId, projectId, userId: data.managerUserId };
            const { count } = await tx.projectMember.updateMany({ where, data: { role: 'MANAGER' } });
            if (count === 0) await tx.projectMember.create({ data: { ...where, role: 'MANAGER' } });
          }
        }
        if ('budget' in body && !(await projectAccess(tx, ctx, project)).canSeeBudget) {
          throw new ValidationError([{ path: 'body.budget', message: 'You cannot change the budget' }]);
        }
        await tx.project.updateMany({ where: { organizationId: ctx.orgId, id: projectId }, data });
        await recordAudit(tx, ctx, { action: 'projects.updated', targetType: 'project', targetId: projectId, diff: { fields: Object.keys(body) } });
      });
      return this.get(ctx, projectId);
    },

    async setLifecycle(ctx, projectId, action) {
      const { project } = await loadProject(prisma, ctx, projectId, 'canManage');
      const now = clock.now();
      const data =
        action === 'archive'
          ? { archivedAt: now }
          : action === 'restore'
            ? { archivedAt: null }
            : { status: 'COMPLETED', closedAt: now };
      if (action === 'restore' && !project.archivedAt) throw new ConflictError('The project is not archived', ERROR_CODES.INVALID_STATE_TRANSITION);
      if (action === 'archive' && project.archivedAt) return this.get(ctx, projectId);
      await prisma.project.updateMany({ where: { organizationId: ctx.orgId, id: projectId }, data });
      await recordAudit(prisma, ctx, { action: `projects.${action}d`, targetType: 'project', targetId: projectId });
      return this.get(ctx, projectId);
    },

    // ─── members ──────────────────────────────────────────────────────────

    async members(ctx, projectId) {
      await loadProject(prisma, ctx, projectId);
      const rows = await prisma.projectMember.findMany({ where: { organizationId: ctx.orgId, projectId } });
      const people = await memberSummaries(prisma, ctx.orgId, rows.map((r) => r.userId));
      return rows
        .map((r) => ({ ...people.get(r.userId), role: r.role }))
        .filter((r) => r.employeeId)
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    async setMembers(ctx, projectId, members) {
      const { project } = await loadProject(prisma, ctx, projectId, 'canManage');
      await withTransaction(prisma, async (tx) => {
        const ids = await resolveEmployeeUserIds(tx, ctx.orgId, members.map((m) => m.employeeId), 'body.members');
        const desired = new Map(members.map((m) => [ids.get(m.employeeId), m.role]));
        if (project.managerUserId) desired.set(project.managerUserId, 'MANAGER');
        await tx.projectMember.deleteMany({ where: { organizationId: ctx.orgId, projectId } });
        await tx.projectMember.createMany({ data: [...desired].map(([userId, role]) => ({ organizationId: ctx.orgId, projectId, userId, role })) });
        // Assignees must be members: drop assignments of people who left the project.
        await tx.taskAssignee.deleteMany({ where: { organizationId: ctx.orgId, task: { projectId }, userId: { notIn: [...desired.keys()] } } });
        await recordAudit(tx, ctx, { action: 'projects.members_set', targetType: 'project', targetId: projectId, diff: { count: desired.size } });
      });
      return this.members(ctx, projectId);
    },

    // ─── statuses & milestones ────────────────────────────────────────────

    async statuses(ctx, projectId) {
      await loadProject(prisma, ctx, projectId);
      return prisma.taskStatus.findMany({ where: { organizationId: ctx.orgId, projectId }, orderBy: { sort: 'asc' } });
    },

    async saveStatus(ctx, projectId, statusId, { name, category }) {
      await loadProject(prisma, ctx, projectId, 'canManage');
      if (statusId) {
        const { count } = await prisma.taskStatus.updateMany({ where: { organizationId: ctx.orgId, projectId, id: statusId }, data: { name, category } });
        if (count !== 1) throw new NotFoundError('Status not found');
      } else {
        const last = await prisma.taskStatus.findFirst({ where: { organizationId: ctx.orgId, projectId }, orderBy: { sort: 'desc' } });
        await prisma.taskStatus.create({ data: { organizationId: ctx.orgId, projectId, name, category, sort: (last?.sort ?? -1) + 1 } });
      }
      return this.statuses(ctx, projectId);
    },

    async reorderStatuses(ctx, projectId, statusIds) {
      await loadProject(prisma, ctx, projectId, 'canManage');
      const existing = await prisma.taskStatus.findMany({ where: { organizationId: ctx.orgId, projectId }, select: { id: true } });
      if (existing.length !== statusIds.length || existing.some((s) => !statusIds.includes(s.id))) {
        throw new ValidationError([{ path: 'body.statusIds', message: 'Provide every status of the project exactly once' }]);
      }
      await prisma.$transaction(statusIds.map((id, sort) => prisma.taskStatus.updateMany({ where: { organizationId: ctx.orgId, id }, data: { sort } })));
      return this.statuses(ctx, projectId);
    },

    async deleteStatus(ctx, projectId, statusId, moveToStatusId) {
      await loadProject(prisma, ctx, projectId, 'canManage');
      await withTransaction(prisma, async (tx) => {
        const statuses = await tx.taskStatus.findMany({ where: { organizationId: ctx.orgId, projectId } });
        if (!statuses.some((s) => s.id === statusId)) throw new NotFoundError('Status not found');
        if (statuses.length <= 1) throw new BusinessRuleError('A project needs at least one status');
        const inUse = await tx.task.count({ where: { organizationId: ctx.orgId, statusId } });
        if (inUse) {
          if (!moveToStatusId || moveToStatusId === statusId || !statuses.some((s) => s.id === moveToStatusId)) {
            throw new ValidationError([{ path: 'body.moveToStatusId', message: 'Choose another status for the tasks in this one' }]);
          }
          await tx.task.updateMany({ where: { organizationId: ctx.orgId, statusId }, data: { statusId: moveToStatusId } });
        }
        await tx.taskStatus.deleteMany({ where: { organizationId: ctx.orgId, id: statusId } });
      });
      return this.statuses(ctx, projectId);
    },

    async milestones(ctx, projectId) {
      await loadProject(prisma, ctx, projectId);
      const rows = await prisma.milestone.findMany({
        where: { organizationId: ctx.orgId, projectId },
        orderBy: [{ dueDate: 'asc' }, { sort: 'asc' }],
        include: { tasks: { where: { archivedAt: null }, select: { status: { select: { category: true } } } } },
      });
      return rows.map(({ tasks, ...m }) => ({
        ...m,
        dueDate: m.dueDate ? isoDate(m.dueDate) : null,
        taskCount: tasks.length,
        doneCount: tasks.filter((t) => t.status.category === 'DONE').length,
      }));
    },

    async saveMilestone(ctx, projectId, milestoneId, body) {
      await loadProject(prisma, ctx, projectId, 'canManage');
      const data = { ...body, ...('dueDate' in body ? { dueDate: body.dueDate ? dateOnly(body.dueDate) : null } : {}) };
      if ('completed' in body) {
        delete data.completed;
        data.completedAt = body.completed ? clock.now() : null;
      }
      if (milestoneId) {
        const { count } = await prisma.milestone.updateMany({ where: { organizationId: ctx.orgId, projectId, id: milestoneId }, data });
        if (count !== 1) throw new NotFoundError('Milestone not found');
      } else {
        await prisma.milestone.create({ data: { organizationId: ctx.orgId, projectId, ...data } });
      }
      return this.milestones(ctx, projectId);
    },

    async deleteMilestone(ctx, projectId, milestoneId) {
      await loadProject(prisma, ctx, projectId, 'canManage');
      await prisma.task.updateMany({ where: { organizationId: ctx.orgId, milestoneId }, data: { milestoneId: null } });
      const { count } = await prisma.milestone.deleteMany({ where: { organizationId: ctx.orgId, projectId, id: milestoneId } });
      if (count !== 1) throw new NotFoundError('Milestone not found');
    },

    // ─── summary ──────────────────────────────────────────────────────────

    /**
     * Project health from real records. Actual hours = Σ time entries on the project (running
     * timers counted to now). Hours utilization = actual ÷ project estimate (derived).
     */
    async summary(ctx, projectId) {
      const { project, access } = await loadProject(prisma, ctx, projectId);
      const now = clock.now();
      const org = await prisma.organization.findUnique({ where: { id: ctx.orgId }, select: { timeZone: true } });
      const today = DateTime.fromJSDate(now, { zone: org.timeZone }).toISODate();
      const [tasks, entries, members] = await Promise.all([
        prisma.task.findMany({
          where: { organizationId: ctx.orgId, projectId, archivedAt: null },
          select: { id: true, dueDate: true, estimatedS: true, status: { select: { category: true } }, assignees: { select: { userId: true } } },
        }),
        prisma.timeEntry.findMany({
          where: { organizationId: ctx.orgId, projectId, deletedAt: null },
          select: { userId: true, durationS: true, endedAt: true, startedAt: true, isBillable: true },
        }),
        prisma.projectMember.findMany({ where: { organizationId: ctx.orgId, projectId }, select: { userId: true, role: true } }),
      ]);
      const live = (e) => (e.endedAt ? e.durationS : secondsBetween(e.startedAt, now));
      const actualS = entries.reduce((s, e) => s + live(e), 0);
      const billableS = entries.filter((e) => e.isBillable).reduce((s, e) => s + live(e), 0);
      const byCategory = { TODO: 0, IN_PROGRESS: 0, DONE: 0, CANCELLED: 0 };
      for (const t of tasks) byCategory[t.status.category] += 1;
      const overdue = tasks.filter((t) => t.dueDate && isoDate(t.dueDate) < today && OPEN.includes(t.status.category)).length;
      const taskEstimateS = tasks.reduce((s, t) => s + (t.estimatedS ?? 0), 0);

      const people = await memberSummaries(prisma, ctx.orgId, members.map((m) => m.userId));
      const workload = members
        .map((m) => {
          const open = tasks.filter((t) => OPEN.includes(t.status.category) && t.assignees.some((a) => a.userId === m.userId));
          return {
            ...people.get(m.userId),
            role: m.role,
            openTasks: open.length,
            openEstimateS: open.reduce((s, t) => s + (t.estimatedS ?? 0), 0),
            trackedS: entries.filter((e) => e.userId === m.userId).reduce((s, e) => s + live(e), 0),
          };
        })
        .filter((w) => w.employeeId)
        .sort((a, b) => b.openTasks - a.openTasks || a.name.localeCompare(b.name));

      return {
        tasks: { total: tasks.length, byCategory, overdue },
        hours: {
          actualS,
          billableS,
          nonBillableS: actualS - billableS,
          estimatedS: project.estimatedS,
          taskEstimateS,
          utilization: project.estimatedS ? Math.round((actualS / project.estimatedS) * 1000) / 10 : null,
        },
        budget: access.canSeeBudget && project.budgetAmount !== null ? { amount: project.budgetAmount.toFixed(2), currency: project.budgetCurrency, costTracking: 'Available with billing rates (Phase 9)' } : null,
        workload,
        orgWide: hasOrgScope(ctx, 'projects.read'),
      };
    },
  };
}
