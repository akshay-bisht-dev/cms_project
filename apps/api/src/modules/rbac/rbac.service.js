import { ForbiddenError } from '../../utils/errors.js';
import { PERMISSION_CATALOG, ROLE_TEMPLATES } from './index.js';
import { SCOPE_FROM_DB, SCOPE_TO_DB } from './permission-catalog.js';

const SCOPE_RANK = { self: 0, team: 1, department: 1, project: 1, org: 2 };

/**
 * Effective permissions for a member: union of all role grants, minus deny overrides.
 * Returns Map<permissionKey, Set<scope>>.
 */
export async function loadEffectivePermissions(db, organizationId, userId) {
  const [grants, overrides] = await Promise.all([
    db.rolePermission.findMany({
      where: { organizationId, role: { members: { some: { organizationId, userId } } } },
      select: { permissionKey: true, scope: true },
    }),
    db.memberPermissionOverride.findMany({ where: { organizationId, userId }, select: { permissionKey: true } }),
  ]);
  const denied = new Set(overrides.map((o) => o.permissionKey));
  const permissions = new Map();
  for (const { permissionKey, scope } of grants) {
    if (denied.has(permissionKey)) continue;
    if (!permissions.has(permissionKey)) permissions.set(permissionKey, new Set());
    permissions.get(permissionKey).add(SCOPE_FROM_DB[scope]);
  }
  return permissions;
}

export function hasPermission(ctx, key) {
  return Boolean(ctx.permissions?.get(key)?.size);
}

export function hasOrgScope(ctx, key) {
  return Boolean(ctx.permissions?.get(key)?.has('org'));
}

/** Serializes permissions for /auth/me: [{ key, scopes: [...] }], widest scope first. */
export function serializePermissions(permissions) {
  return [...permissions.entries()]
    .map(([key, scopes]) => ({ key, scopes: [...scopes].sort((a, b) => SCOPE_RANK[b] - SCOPE_RANK[a]) }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

async function departmentDescendants(db, organizationId, rootIds) {
  if (rootIds.length === 0) return [];
  const all = await db.department.findMany({ where: { organizationId }, select: { id: true, parentId: true } });
  const children = new Map();
  for (const d of all) {
    if (!d.parentId) continue;
    if (!children.has(d.parentId)) children.set(d.parentId, []);
    children.get(d.parentId).push(d.id);
  }
  const result = new Set(rootIds);
  const queue = [...rootIds];
  while (queue.length) {
    for (const child of children.get(queue.shift()) ?? []) {
      if (!result.has(child)) {
        result.add(child);
        queue.push(child);
      }
    }
  }
  return [...result];
}

/**
 * Resolves which members a permission covers for the caller.
 * Every scope includes the caller themself. Returns { all: true } for org scope, otherwise
 * { all: false, userIds: Set }. Project scope covers members of projects the caller manages.
 */
export async function resolveMemberScope(db, ctx, key) {
  // Memoized per request: list endpoints check the same scope for many rows.
  ctx.scopeCache ??= new Map();
  if (!ctx.scopeCache.has(key)) ctx.scopeCache.set(key, computeMemberScope(db, ctx, key));
  return ctx.scopeCache.get(key);
}

async function computeMemberScope(db, ctx, key) {
  const scopes = ctx.permissions?.get(key);
  if (!scopes?.size) return { all: false, userIds: new Set() };
  if (scopes.has('org')) return { all: true };

  const { orgId: organizationId, userId } = ctx;
  const userIds = new Set([userId]);

  if (scopes.has('team')) {
    const members = await db.teamMember.findMany({
      where: { organizationId, team: { leadUserId: userId, archivedAt: null } },
      select: { userId: true },
    });
    for (const m of members) userIds.add(m.userId);
  }

  if (scopes.has('department')) {
    const managed = await db.department.findMany({
      where: { organizationId, managerUserId: userId, archivedAt: null },
      select: { id: true },
    });
    const departmentIds = await departmentDescendants(db, organizationId, managed.map((d) => d.id));
    if (departmentIds.length) {
      const profiles = await db.employeeProfile.findMany({
        where: { organizationId, departmentId: { in: departmentIds } },
        select: { userId: true },
      });
      for (const p of profiles) userIds.add(p.userId);
    }
  }

  if (scopes.has('project')) {
    // Everyone on projects the caller manages (as project manager or with the MANAGER project role).
    const managed = await db.project.findMany({
      where: { organizationId, archivedAt: null, OR: [{ managerUserId: userId }, { members: { some: { userId, role: 'MANAGER' } } }] },
      select: { id: true },
    });
    if (managed.length) {
      const members = await db.projectMember.findMany({
        where: { organizationId, projectId: { in: managed.map((p) => p.id) } },
        select: { userId: true },
      });
      for (const m of members) userIds.add(m.userId);
    }
  }

  return { all: false, userIds };
}

/** Throws 403 unless the caller's scope for `key` covers `targetUserId`. */
export async function assertCoversMember(db, ctx, key, targetUserId) {
  if (!(await coversMember(db, ctx, key, targetUserId))) {
    throw new ForbiddenError('You do not have permission to access this employee');
  }
}

export async function coversMember(db, ctx, key, targetUserId) {
  const scope = await resolveMemberScope(db, ctx, key);
  return scope.all || scope.userIds.has(targetUserId);
}

/** Builds role_permissions rows for a role template. */
export function templatePermissions(template) {
  if (template.allPermissions) {
    return PERMISSION_CATALOG.map((p) => ({ permissionKey: p.key, scope: p.allowedScopes.at(-1) }));
  }
  return Object.entries(template.permissions).map(([permissionKey, scope]) => ({ permissionKey, scope }));
}

/** Creates the system roles for a new organization and returns them keyed by role key. */
export async function createSystemRoles(db, organizationId) {
  const roles = {};
  for (const template of ROLE_TEMPLATES) {
    const role = await db.role.create({
      data: { organizationId, key: template.key, name: template.name, description: template.description, isSystem: true },
    });
    await db.rolePermission.createMany({
      data: templatePermissions(template).map((p) => ({ organizationId, roleId: role.id, permissionKey: p.permissionKey, scope: SCOPE_TO_DB[p.scope] })),
    });
    roles[template.key] = role;
  }
  return roles;
}

/**
 * Whether another member (e.g. an employee's manager) could act on `targetUserId` with `key`.
 * Used to decide who to notify about pending approvals.
 */
export async function memberCanActOn(db, organizationId, actorUserId, key, targetUserId) {
  if (!actorUserId || actorUserId === targetUserId) return false;
  const member = await db.organizationMember.findUnique({ where: { organizationId_userId: { organizationId, userId: actorUserId } } });
  if (member?.status !== 'ACTIVE') return false;
  const ctx = { orgId: organizationId, userId: actorUserId, permissions: await loadEffectivePermissions(db, organizationId, actorUserId) };
  return coversMember(db, ctx, key, targetUserId);
}
