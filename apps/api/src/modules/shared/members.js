import { ValidationError } from '../../utils/errors.js';

/**
 * The public "employeeId" is the organization_members.id; tenant tables reference members by
 * (organization_id, user_id). These helpers translate between the two.
 */
export async function resolveEmployeeUserIds(db, organizationId, employeeIds, path = 'body.employeeId') {
  const unique = [...new Set(employeeIds.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const members = await db.organizationMember.findMany({
    where: { organizationId, id: { in: unique }, status: { in: ['ACTIVE', 'INVITED'] } },
    select: { id: true, userId: true },
  });
  if (members.length !== unique.length) {
    throw new ValidationError([{ path, message: 'One or more employees were not found in this organization' }]);
  }
  return new Map(members.map((m) => [m.id, m.userId]));
}

export async function resolveEmployeeUserId(db, organizationId, employeeId, path) {
  if (!employeeId) return null;
  return (await resolveEmployeeUserIds(db, organizationId, [employeeId], path)).get(employeeId);
}

/** Loads { employeeId, userId, name } summaries for a set of user ids in one organization. */
export async function memberSummaries(db, organizationId, userIds) {
  const unique = [...new Set(userIds.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const members = await db.organizationMember.findMany({
    where: { organizationId, userId: { in: unique } },
    select: { id: true, userId: true, status: true, user: { select: { name: true, email: true } } },
  });
  return new Map(members.map((m) => [m.userId, { employeeId: m.id, name: m.user.name, email: m.user.email, status: m.status }]));
}
