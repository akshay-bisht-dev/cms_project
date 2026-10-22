import { ERROR_CODES } from '@orbit/shared-constants';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../../services/audit.js';
import { withTransaction } from '../../repositories/tx.js';
import { hasOrgScope } from '../rbac/rbac.service.js';
import { OWNER_ROLE_KEY, PERMISSIONS_BY_KEY } from '../rbac/index.js';
import { SCOPE_FROM_DB, SCOPE_TO_DB } from '../rbac/permission-catalog.js';
import { notify } from '../notifications/notifications.service.js';

const SCOPE_RANK = { self: 0, team: 1, department: 1, project: 1, org: 2 };

// The baseline role every new hire gets. Anyone allowed to invite may assign it; it grants only
// self-scoped access plus read-only directory/project visibility.
const BASELINE_ROLE_KEYS = new Set(['EMPLOYEE']);

function validateGrants(grants) {
  const details = [];
  const seen = new Set();
  grants.forEach((g, i) => {
    const def = PERMISSIONS_BY_KEY.get(g.key);
    if (!def) details.push({ path: `body.permissions.${i}.key`, message: `Unknown permission "${g.key}"` });
    else if (!def.allowedScopes.includes(g.scope)) {
      details.push({ path: `body.permissions.${i}.scope`, message: `"${g.key}" allows scopes: ${def.allowedScopes.join(', ')}` });
    }
    if (seen.has(g.key)) details.push({ path: `body.permissions.${i}.key`, message: `Duplicate permission "${g.key}"` });
    seen.add(g.key);
  });
  if (details.length) throw new ValidationError(details);
}

function roleKeyFromName(name) {
  return `CUSTOM_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 48)}`;
}

function serializeRole(role, { includePermissions }) {
  return {
    id: role.id,
    key: role.key,
    name: role.name,
    description: role.description,
    isSystem: role.isSystem,
    editable: role.key !== OWNER_ROLE_KEY,
    memberCount: role._count?.members ?? undefined,
    permissions: includePermissions
      ? role.permissions.map((p) => ({ key: p.permissionKey, scope: SCOPE_FROM_DB[p.scope] })).sort((a, b) => a.key.localeCompare(b.key))
      : undefined,
  };
}

/** Throws unless the organization keeps at least one ACTIVE member holding the OWNER role. */
export async function assertOwnerRemains(db, organizationId) {
  const owners = await db.memberRole.count({
    where: { organizationId, role: { key: OWNER_ROLE_KEY }, member: { status: 'ACTIVE' } },
  });
  if (owners === 0) throw new ConflictError('The organization must keep at least one active owner', ERROR_CODES.LAST_OWNER);
}

/**
 * Privilege-escalation guard. Members with roles.manage may assign any role. Others (e.g. HR with
 * invitations.manage) may assign the baseline Employee role, plus roles whose every grant they
 * hold themselves at the same or wider scope.
 */
export async function assertCanAssignRoles(db, ctx, roleIds) {
  const roles = await db.role.findMany({
    where: { organizationId: ctx.orgId, id: { in: roleIds } },
    include: { permissions: true },
  });
  if (roles.length !== new Set(roleIds).size) throw new ValidationError([{ path: 'body.roleIds', message: 'One or more roles were not found' }]);
  if (hasOrgScope(ctx, 'roles.manage')) return roles;

  for (const role of roles) {
    if (role.key === OWNER_ROLE_KEY) throw new ForbiddenError('Only owners can grant the Owner role');
    if (role.isSystem && BASELINE_ROLE_KEYS.has(role.key)) continue;
    for (const grant of role.permissions) {
      const mine = ctx.permissions.get(grant.permissionKey);
      const needed = SCOPE_RANK[SCOPE_FROM_DB[grant.scope]];
      const best = mine ? Math.max(...[...mine].map((s) => SCOPE_RANK[s])) : -1;
      if (best < needed) throw new ForbiddenError(`You cannot assign the "${role.name}" role because it grants permissions you do not have`);
    }
  }
  return roles;
}

export function createRoleService({ prisma, cipher, env }) {
  async function findRole(db, organizationId, roleId) {
    const role = await db.role.findFirst({ where: { organizationId, id: roleId }, include: { permissions: true, _count: { select: { members: true } } } });
    if (!role) throw new NotFoundError('Role not found');
    return role;
  }

  async function memberByEmployeeId(db, organizationId, employeeId) {
    const member = await db.organizationMember.findFirst({ where: { organizationId, id: employeeId } });
    if (!member) throw new NotFoundError('Employee not found');
    return member;
  }

  return {
    listPermissions() {
      return [...PERMISSIONS_BY_KEY.values()];
    },

    async list(ctx) {
      const includePermissions = hasOrgScope(ctx, 'roles.manage');
      const roles = await prisma.role.findMany({
        where: { organizationId: ctx.orgId },
        include: { permissions: includePermissions, _count: { select: { members: true } } },
        orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
      });
      return roles.map((r) => serializeRole(r, { includePermissions }));
    },

    async get(ctx, roleId) {
      return serializeRole(await findRole(prisma, ctx.orgId, roleId), { includePermissions: true });
    },

    async create(ctx, { name, description, permissions }) {
      validateGrants(permissions);
      return withTransaction(prisma, async (tx) => {
        const role = await tx.role.create({
          data: { organizationId: ctx.orgId, key: roleKeyFromName(name), name, description: description ?? null, isSystem: false },
        });
        await tx.rolePermission.createMany({
          data: permissions.map((p) => ({ organizationId: ctx.orgId, roleId: role.id, permissionKey: p.key, scope: SCOPE_TO_DB[p.scope] })),
        });
        await recordAudit(tx, ctx, { action: 'roles.created', targetType: 'role', targetId: role.id, diff: { name, permissions } });
        return serializeRole(await findRole(tx, ctx.orgId, role.id), { includePermissions: true });
      });
    },

    async update(ctx, roleId, patch) {
      if (patch.permissions) validateGrants(patch.permissions);
      return withTransaction(prisma, async (tx) => {
        const role = await findRole(tx, ctx.orgId, roleId);
        if (role.key === OWNER_ROLE_KEY) throw new ForbiddenError('The Owner role cannot be changed');
        await tx.role.updateMany({
          where: { organizationId: ctx.orgId, id: roleId },
          data: { ...(patch.name ? { name: patch.name } : {}), ...('description' in patch ? { description: patch.description } : {}) },
        });
        if (patch.permissions) {
          await tx.rolePermission.deleteMany({ where: { organizationId: ctx.orgId, roleId } });
          await tx.rolePermission.createMany({
            data: patch.permissions.map((p) => ({ organizationId: ctx.orgId, roleId, permissionKey: p.key, scope: SCOPE_TO_DB[p.scope] })),
          });
        }
        await recordAudit(tx, ctx, {
          action: 'roles.updated',
          targetType: 'role',
          targetId: roleId,
          diff: { before: serializeRole(role, { includePermissions: true }), after: patch },
        });
        return serializeRole(await findRole(tx, ctx.orgId, roleId), { includePermissions: true });
      });
    },

    async remove(ctx, roleId) {
      await withTransaction(prisma, async (tx) => {
        const role = await findRole(tx, ctx.orgId, roleId);
        if (role.isSystem) throw new ForbiddenError('System roles cannot be deleted');
        if (role._count.members > 0) throw new ConflictError('Unassign this role from all members before deleting it');
        await tx.role.deleteMany({ where: { organizationId: ctx.orgId, id: roleId } });
        await recordAudit(tx, ctx, { action: 'roles.deleted', targetType: 'role', targetId: roleId, diff: { name: role.name } });
      });
    },

    async setMemberRoles(ctx, employeeId, roleIds) {
      return withTransaction(prisma, async (tx) => {
        const member = await memberByEmployeeId(tx, ctx.orgId, employeeId);
        const roles = await assertCanAssignRoles(tx, ctx, roleIds);
        const before = await tx.memberRole.findMany({ where: { organizationId: ctx.orgId, userId: member.userId }, include: { role: true } });
        await tx.memberRole.deleteMany({ where: { organizationId: ctx.orgId, userId: member.userId } });
        await tx.memberRole.createMany({ data: roleIds.map((roleId) => ({ organizationId: ctx.orgId, userId: member.userId, roleId })) });
        await assertOwnerRemains(tx, ctx.orgId);
        await recordAudit(tx, ctx, {
          action: 'roles.assigned',
          targetType: 'employee',
          targetId: member.id,
          diff: { from: before.map((r) => r.role.key), to: roles.map((r) => r.key) },
        });
        if (member.userId !== ctx.userId) {
          await notify(tx, ctx, {
            cipher,
            appOrigin: env.APP_ORIGIN,
            organizationId: ctx.orgId,
            recipientUserId: member.userId,
            type: 'access.roles_changed',
            title: 'Your roles changed',
            body: `Your roles are now: ${roles.map((r) => r.name).join(', ')}. What you can see and do in Orbit may have changed.`,
            link: `/employees/${member.id}`,
            subjectType: 'employee',
            subjectId: member.id,
            dedupeKey: `roles:${ctx.requestId}`,
          });
        }
        return roles.map((r) => ({ id: r.id, key: r.key, name: r.name }));
      });
    },

    async setOverrides(ctx, employeeId, { deny, reason }) {
      const unknown = deny.filter((k) => !PERMISSIONS_BY_KEY.has(k));
      if (unknown.length) throw new ValidationError([{ path: 'body.deny', message: `Unknown permissions: ${unknown.join(', ')}` }]);
      return withTransaction(prisma, async (tx) => {
        const member = await memberByEmployeeId(tx, ctx.orgId, employeeId);
        if (member.userId === ctx.userId) throw new ForbiddenError('You cannot restrict your own permissions');
        await tx.memberPermissionOverride.deleteMany({ where: { organizationId: ctx.orgId, userId: member.userId } });
        await tx.memberPermissionOverride.createMany({
          data: [...new Set(deny)].map((permissionKey) => ({ organizationId: ctx.orgId, userId: member.userId, permissionKey, reason: reason ?? null, createdById: ctx.userId })),
        });
        await recordAudit(tx, ctx, { action: 'roles.overrides_set', targetType: 'employee', targetId: member.id, diff: { deny, reason } });
        return { deny: [...new Set(deny)].sort() };
      });
    },
  };
}
