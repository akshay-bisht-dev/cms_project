import { isValidTimeZone, memberTimeZone, scheduleWindow } from '../../utils/time.js';

/** Effective schedule for a member: MEMBER > TEAM > DEPARTMENT assignment > organization default. */
export async function resolveSchedule(db, organizationId, userId) {
  const [profile, teams] = await Promise.all([
    db.employeeProfile.findUnique({ where: { organizationId_userId: { organizationId, userId } }, select: { departmentId: true } }),
    db.teamMember.findMany({ where: { organizationId, userId }, select: { teamId: true } }),
  ]);
  const candidates = await db.scheduleAssignment.findMany({
    where: {
      organizationId,
      OR: [
        { targetType: 'MEMBER', targetId: userId },
        ...(teams.length ? [{ targetType: 'TEAM', targetId: { in: teams.map((t) => t.teamId) } }] : []),
        ...(profile?.departmentId ? [{ targetType: 'DEPARTMENT', targetId: profile.departmentId }] : []),
      ],
      schedule: { archivedAt: null },
    },
    include: { schedule: true },
    orderBy: { createdAt: 'desc' },
  });
  for (const level of ['MEMBER', 'TEAM', 'DEPARTMENT']) {
    const match = candidates.find((c) => c.targetType === level);
    if (match) return match.schedule;
  }
  return db.workSchedule.findFirst({ where: { organizationId, isDefault: true, archivedAt: null } });
}

/** Zone and schedule context for a member, computed once per transition. */
export async function memberCalendar(db, organizationId, userId) {
  const [profile, organization, schedule] = await Promise.all([
    db.employeeProfile.findUnique({ where: { organizationId_userId: { organizationId, userId } }, select: { timeZone: true, managerUserId: true } }),
    db.organization.findUnique({ where: { id: organizationId }, select: { timeZone: true } }),
    resolveSchedule(db, organizationId, userId),
  ]);
  // A schedule pinned to a zone (e.g. an office shift) wins; otherwise the member's own zone.
  const zone = isValidTimeZone(schedule?.timeZone) ? schedule.timeZone : memberTimeZone(profile?.timeZone, organization.timeZone);
  return { zone, schedule, managerUserId: profile?.managerUserId ?? null };
}

/**
 * Zones for many members in five queries, by the same rules as memberCalendar (schedule pinned to a
 * zone > member's zone > organization's zone; schedule precedence as in resolveSchedule). Used where
 * a request covers a whole team or organization, so the lookup does not cost queries per person.
 */
export async function memberZones(db, organizationId, userIds) {
  if (!userIds.length) return new Map();
  const [organization, profiles, teams, assignments, fallback] = await Promise.all([
    db.organization.findUnique({ where: { id: organizationId }, select: { timeZone: true } }),
    db.employeeProfile.findMany({ where: { organizationId, userId: { in: userIds } }, select: { userId: true, timeZone: true, departmentId: true } }),
    db.teamMember.findMany({ where: { organizationId, userId: { in: userIds } }, select: { userId: true, teamId: true } }),
    db.scheduleAssignment.findMany({ where: { organizationId, schedule: { archivedAt: null } }, include: { schedule: { select: { timeZone: true } } }, orderBy: { createdAt: 'desc' } }),
    db.workSchedule.findFirst({ where: { organizationId, isDefault: true, archivedAt: null }, select: { timeZone: true } }),
  ]);
  const profileOf = new Map(profiles.map((p) => [p.userId, p]));
  const teamsOf = new Map();
  for (const t of teams) teamsOf.set(t.userId, [...(teamsOf.get(t.userId) ?? []), t.teamId]);
  const zones = new Map();
  for (const userId of userIds) {
    const profile = profileOf.get(userId);
    const myTeams = new Set(teamsOf.get(userId) ?? []);
    // Newest assignment first within each level, exactly as resolveSchedule orders its candidates.
    const match =
      assignments.find((a) => a.targetType === 'MEMBER' && a.targetId === userId) ??
      assignments.find((a) => a.targetType === 'TEAM' && myTeams.has(a.targetId)) ??
      (profile?.departmentId ? assignments.find((a) => a.targetType === 'DEPARTMENT' && a.targetId === profile.departmentId) : undefined);
    const schedule = match ? match.schedule : fallback;
    zones.set(userId, isValidTimeZone(schedule?.timeZone) ? schedule.timeZone : memberTimeZone(profile?.timeZone, organization.timeZone));
  }
  return zones;
}

/** Snapshot stored on the attendance record so later schedule edits never rewrite history. */
export function scheduleSnapshot(schedule, date, zone) {
  if (!schedule) return null;
  const window = scheduleWindow(schedule, date, zone);
  return {
    scheduleId: schedule.id,
    name: schedule.name,
    type: schedule.type,
    window: window ? { start: window.start.toISOString(), end: window.end.toISOString(), expectedS: window.expectedS } : null,
  };
}
