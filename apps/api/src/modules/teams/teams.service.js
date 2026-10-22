import { ForbiddenError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../../services/audit.js';
import { withTransaction } from '../../repositories/tx.js';
import { hasOrgScope } from '../rbac/rbac.service.js';
import { memberSummaries, resolveEmployeeUserId, resolveEmployeeUserIds } from '../shared/members.js';

export function createTeamService({ prisma, clock }) {
  async function find(db, organizationId, id) {
    const team = await db.team.findFirst({ where: { organizationId, id }, include: { members: { select: { userId: true } } } });
    if (!team) throw new NotFoundError('Team not found');
    return team;
  }

  async function assertDepartment(db, organizationId, departmentId) {
    if (!departmentId) return;
    const exists = await db.department.findFirst({ where: { organizationId, id: departmentId, archivedAt: null } });
    if (!exists) throw new ValidationError([{ path: 'body.departmentId', message: 'Department not found' }]);
  }

  async function serialize(db, organizationId, teams, { withMembers = false } = {}) {
    const userIds = teams.flatMap((t) => [t.leadUserId, ...(withMembers ? t.members.map((m) => m.userId) : [])]);
    const people = await memberSummaries(db, organizationId, userIds);
    return teams.map((t) => ({
      id: t.id,
      name: t.name,
      departmentId: t.departmentId,
      lead: t.leadUserId ? (people.get(t.leadUserId) ?? null) : null,
      memberCount: t.members.length,
      members: withMembers ? t.members.map((m) => people.get(m.userId)).filter(Boolean) : undefined,
      archivedAt: t.archivedAt,
      createdAt: t.createdAt,
    }));
  }

  async function replaceMembers(tx, organizationId, teamId, userIds) {
    await tx.teamMember.deleteMany({ where: { organizationId, teamId } });
    if (userIds.length) await tx.teamMember.createMany({ data: userIds.map((userId) => ({ organizationId, teamId, userId })) });
  }

  return {
    async list(ctx, { includeArchived, departmentId }) {
      const teams = await prisma.team.findMany({
        where: { organizationId: ctx.orgId, ...(includeArchived === 'true' ? {} : { archivedAt: null }), ...(departmentId ? { departmentId } : {}) },
        include: { members: { select: { userId: true } } },
        orderBy: { name: 'asc' },
      });
      return serialize(prisma, ctx.orgId, teams);
    },

    async get(ctx, id) {
      return (await serialize(prisma, ctx.orgId, [await find(prisma, ctx.orgId, id)], { withMembers: true }))[0];
    },

    async create(ctx, body) {
      if (!hasOrgScope(ctx, 'teams.manage')) throw new ForbiddenError('Only organization-wide team managers can create teams');
      return withTransaction(prisma, async (tx) => {
        await assertDepartment(tx, ctx.orgId, body.departmentId);
        const leadUserId = await resolveEmployeeUserId(tx, ctx.orgId, body.leadEmployeeId, 'body.leadEmployeeId');
        const members = await resolveEmployeeUserIds(tx, ctx.orgId, body.memberEmployeeIds, 'body.memberEmployeeIds');
        const team = await tx.team.create({ data: { organizationId: ctx.orgId, name: body.name, departmentId: body.departmentId ?? null, leadUserId } });
        // The lead is always a member of their own team.
        await replaceMembers(tx, ctx.orgId, team.id, [...new Set([...members.values(), leadUserId].filter(Boolean))]);
        await recordAudit(tx, ctx, { action: 'teams.created', targetType: 'team', targetId: team.id, diff: body });
        return (await serialize(tx, ctx.orgId, [await find(tx, ctx.orgId, team.id)], { withMembers: true }))[0];
      });
    },

    async update(ctx, id, body) {
      if (!hasOrgScope(ctx, 'teams.manage')) throw new ForbiddenError('Team leads can change membership only');
      return withTransaction(prisma, async (tx) => {
        const before = await find(tx, ctx.orgId, id);
        const data = {};
        if (body.name !== undefined) data.name = body.name;
        if ('departmentId' in body) {
          await assertDepartment(tx, ctx.orgId, body.departmentId);
          data.departmentId = body.departmentId ?? null;
        }
        if ('leadEmployeeId' in body) data.leadUserId = await resolveEmployeeUserId(tx, ctx.orgId, body.leadEmployeeId, 'body.leadEmployeeId');
        await tx.team.updateMany({ where: { organizationId: ctx.orgId, id }, data });
        if (data.leadUserId && !before.members.some((m) => m.userId === data.leadUserId)) {
          await tx.teamMember.create({ data: { organizationId: ctx.orgId, teamId: id, userId: data.leadUserId } });
        }
        await recordAudit(tx, ctx, { action: 'teams.updated', targetType: 'team', targetId: id, diff: { changes: body } });
        return (await serialize(tx, ctx.orgId, [await find(tx, ctx.orgId, id)], { withMembers: true }))[0];
      });
    },

    async setMembers(ctx, id, employeeIds) {
      return withTransaction(prisma, async (tx) => {
        const team = await find(tx, ctx.orgId, id);
        if (team.archivedAt) throw new ValidationError([{ path: 'params.teamId', message: 'Archived teams cannot be changed' }]);
        // Team-scoped managers (team leads) may manage only the teams they lead.
        if (!hasOrgScope(ctx, 'teams.manage') && team.leadUserId !== ctx.userId) {
          throw new ForbiddenError('You can only manage members of teams you lead');
        }
        const members = await resolveEmployeeUserIds(tx, ctx.orgId, employeeIds, 'body.employeeIds');
        const userIds = [...new Set([...members.values(), team.leadUserId].filter(Boolean))];
        await replaceMembers(tx, ctx.orgId, id, userIds);
        await recordAudit(tx, ctx, {
          action: 'teams.members_set',
          targetType: 'team',
          targetId: id,
          diff: { from: team.members.map((m) => m.userId), to: userIds },
        });
        return (await serialize(tx, ctx.orgId, [await find(tx, ctx.orgId, id)], { withMembers: true }))[0];
      });
    },

    async archive(ctx, id) {
      if (!hasOrgScope(ctx, 'teams.manage')) throw new ForbiddenError('Only organization-wide team managers can archive teams');
      await withTransaction(prisma, async (tx) => {
        const team = await find(tx, ctx.orgId, id);
        if (team.archivedAt) return;
        await tx.team.updateMany({ where: { organizationId: ctx.orgId, id }, data: { archivedAt: clock.now() } });
        await recordAudit(tx, ctx, { action: 'teams.archived', targetType: 'team', targetId: id });
      });
    },
  };
}
