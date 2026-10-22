import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../../services/audit.js';
import { withTransaction } from '../../repositories/tx.js';
import { memberSummaries, resolveEmployeeUserId } from '../shared/members.js';

export function createDepartmentService({ prisma, clock }) {
  async function find(db, organizationId, id) {
    const department = await db.department.findFirst({ where: { organizationId, id } });
    if (!department) throw new NotFoundError('Department not found');
    return department;
  }

  async function assertParentValid(db, organizationId, departmentId, parentId) {
    if (!parentId) return;
    const all = await db.department.findMany({ where: { organizationId }, select: { id: true, parentId: true, archivedAt: true } });
    const byId = new Map(all.map((d) => [d.id, d]));
    const parent = byId.get(parentId);
    if (!parent || parent.archivedAt) throw new ValidationError([{ path: 'body.parentId', message: 'Parent department not found' }]);
    // Walk up from the proposed parent; reaching this department would create a cycle.
    for (let cursor = parent; cursor; cursor = byId.get(cursor.parentId)) {
      if (cursor.id === departmentId) throw new ValidationError([{ path: 'body.parentId', message: 'A department cannot be nested under itself' }]);
    }
  }

  async function serialize(db, organizationId, departments) {
    const [managers, counts] = await Promise.all([
      memberSummaries(db, organizationId, departments.map((d) => d.managerUserId)),
      db.employeeProfile.groupBy({
        by: ['departmentId'],
        where: { organizationId, departmentId: { in: departments.map((d) => d.id) }, member: { status: { in: ['ACTIVE', 'INVITED'] } } },
        _count: { _all: true },
      }),
    ]);
    const countBy = new Map(counts.map((c) => [c.departmentId, c._count._all]));
    return departments.map((d) => ({
      id: d.id,
      name: d.name,
      code: d.code,
      parentId: d.parentId,
      manager: d.managerUserId ? (managers.get(d.managerUserId) ?? null) : null,
      employeeCount: countBy.get(d.id) ?? 0,
      archivedAt: d.archivedAt,
      createdAt: d.createdAt,
    }));
  }

  return {
    async list(ctx, { includeArchived }) {
      const departments = await prisma.department.findMany({
        where: { organizationId: ctx.orgId, ...(includeArchived === 'true' ? {} : { archivedAt: null }) },
        orderBy: { name: 'asc' },
      });
      return serialize(prisma, ctx.orgId, departments);
    },

    async get(ctx, id) {
      const [department] = await serialize(prisma, ctx.orgId, [await find(prisma, ctx.orgId, id)]);
      return department;
    },

    async create(ctx, body) {
      return withTransaction(prisma, async (tx) => {
        await assertParentValid(tx, ctx.orgId, null, body.parentId);
        const managerUserId = await resolveEmployeeUserId(tx, ctx.orgId, body.managerEmployeeId, 'body.managerEmployeeId');
        const department = await tx.department.create({
          data: { organizationId: ctx.orgId, name: body.name, code: body.code, parentId: body.parentId ?? null, managerUserId },
        });
        await recordAudit(tx, ctx, { action: 'departments.created', targetType: 'department', targetId: department.id, diff: body });
        return (await serialize(tx, ctx.orgId, [department]))[0];
      });
    },

    async update(ctx, id, body) {
      return withTransaction(prisma, async (tx) => {
        const before = await find(tx, ctx.orgId, id);
        if ('parentId' in body) await assertParentValid(tx, ctx.orgId, id, body.parentId);
        const data = {};
        if (body.name !== undefined) data.name = body.name;
        if (body.code !== undefined) data.code = body.code;
        if ('parentId' in body) data.parentId = body.parentId ?? null;
        if ('managerEmployeeId' in body) data.managerUserId = await resolveEmployeeUserId(tx, ctx.orgId, body.managerEmployeeId, 'body.managerEmployeeId');
        await tx.department.updateMany({ where: { organizationId: ctx.orgId, id }, data });
        await recordAudit(tx, ctx, { action: 'departments.updated', targetType: 'department', targetId: id, diff: { before, changes: body } });
        return (await serialize(tx, ctx.orgId, [await find(tx, ctx.orgId, id)]))[0];
      });
    },

    async archive(ctx, id) {
      await withTransaction(prisma, async (tx) => {
        const department = await find(tx, ctx.orgId, id);
        if (department.archivedAt) return;
        const activeChildren = await tx.department.count({ where: { organizationId: ctx.orgId, parentId: id, archivedAt: null } });
        if (activeChildren > 0) throw new ConflictError('Archive or move the sub-departments first');
        await tx.department.updateMany({ where: { organizationId: ctx.orgId, id }, data: { archivedAt: clock.now() } });
        await recordAudit(tx, ctx, { action: 'departments.archived', targetType: 'department', targetId: id });
      });
    },
  };
}
