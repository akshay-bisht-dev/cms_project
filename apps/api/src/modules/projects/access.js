import { ForbiddenError, NotFoundError } from '../../utils/errors.js';
import { hasOrgScope, hasPermission } from '../rbac/rbac.service.js';

/**
 * Project access combines the role grant (org or project scope) with the caller's role on the
 * project and the project's visibility (docs/permissions-matrix.md):
 * - read:   projects.read@org, or a project member, or an ORG-visible project
 * - manage: projects.manage@org, or project role MANAGER (or the project's manager)
 * - tasks:  tasks.update@org, or project role MANAGER/MEMBER
 */
export async function projectRole(db, ctx, project) {
  if (project.managerUserId === ctx.userId) return 'MANAGER';
  const membership = await db.projectMember.findFirst({ where: { organizationId: ctx.orgId, projectId: project.id, userId: ctx.userId } });
  return membership?.role ?? null;
}

export async function projectAccess(db, ctx, project) {
  const role = await projectRole(db, ctx, project);
  const canRead = hasOrgScope(ctx, 'projects.read') || (hasPermission(ctx, 'projects.read') && (role !== null || project.visibility === 'ORG'));
  const canManage = hasOrgScope(ctx, 'projects.manage') || (hasPermission(ctx, 'projects.manage') && role === 'MANAGER');
  const canEditTasks = hasOrgScope(ctx, 'tasks.update') || (hasPermission(ctx, 'tasks.update') && ['MANAGER', 'MEMBER'].includes(role));
  const canCreateTasks = hasOrgScope(ctx, 'tasks.create') || (hasPermission(ctx, 'tasks.create') && ['MANAGER', 'MEMBER'].includes(role));
  const canReadTasks = canRead && (hasPermission(ctx, 'tasks.read') || canManage);
  return {
    role,
    canRead,
    canManage,
    canReadTasks,
    canCreateTasks,
    canEditTasks,
    canSeeBudget: hasOrgScope(ctx, 'projects.budget.read') || (hasPermission(ctx, 'projects.budget.read') && role === 'MANAGER'),
  };
}

/** Prisma filter for projects the caller can list. */
export function readableProjectsWhere(ctx) {
  if (hasOrgScope(ctx, 'projects.read')) return { organizationId: ctx.orgId };
  if (!hasPermission(ctx, 'projects.read')) return { organizationId: ctx.orgId, id: '__none__' };
  return {
    organizationId: ctx.orgId,
    OR: [{ visibility: 'ORG' }, { managerUserId: ctx.userId }, { members: { some: { userId: ctx.userId } } }],
  };
}

/** Loads a project and enforces an access level; missing and unreadable both answer 404. */
export async function loadProject(db, ctx, projectId, need = 'canRead') {
  const project = await db.project.findFirst({ where: { organizationId: ctx.orgId, id: projectId } });
  if (!project) throw new NotFoundError('Project not found');
  const access = await projectAccess(db, ctx, project);
  if (!access.canRead) throw new NotFoundError('Project not found');
  if (!access[need]) throw new ForbiddenError();
  return { project, access };
}
