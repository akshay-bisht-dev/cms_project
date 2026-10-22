import { DateTime } from 'luxon';
import { hasOrgScope, hasPermission, resolveMemberScope } from '../rbac/rbac.service.js';
import { readableProjectsWhere } from '../projects/access.js';

const RECENT_DAYS = 30;

/**
 * Dashboard aggregates computed from real records, limited to the viewer's dashboard.read scope.
 * Attendance, time and project widgets join this summary in the phases that create that data.
 */
export function createDashboardService({ prisma, clock }) {
  return {
    async summary(ctx, { departmentId, teamId }) {
      const scope = await resolveMemberScope(prisma, ctx, 'dashboard.read');
      const members = { organizationId: ctx.orgId, memberType: 'EMPLOYEE' };
      if (!scope.all) members.userId = { in: [...scope.userIds] };
      if (departmentId) members.profile = { is: { departmentId } };
      if (teamId) members.teamMemberships = { some: { teamId } };

      const since = new Date(clock.now().getTime() - RECENT_DAYS * 86_400_000);
      // "Today" uses the organization's zone so everyone in the summary shares one boundary.
      const todayStart = DateTime.fromJSDate(clock.now(), { zone: ctx.organization?.timeZone ?? 'UTC' }).startOf('day').toJSDate();
      const memberFilter = scope.all ? {} : { userId: { in: [...scope.userIds] } };
      const [byStatus, activeProfiles, recent, pendingInvitations, states, entries, approvable, corrections] = await Promise.all([
        prisma.organizationMember.groupBy({ by: ['status'], where: members, _count: { _all: true } }),
        prisma.employeeProfile.findMany({
          where: { organizationId: ctx.orgId, member: { ...members, status: 'ACTIVE' } },
          select: { departmentId: true, completionPct: true, department: { select: { name: true } } },
        }),
        prisma.organizationMember.findMany({
          where: { ...members, status: 'ACTIVE', joinedAt: { gte: since } },
          orderBy: { joinedAt: 'desc' },
          take: 5,
          select: { id: true, joinedAt: true, user: { select: { name: true } }, profile: { select: { designation: true } } },
        }),
        hasOrgScope(ctx, 'invitations.manage')
          ? prisma.invitation.count({ where: { organizationId: ctx.orgId, acceptedAt: null, revokedAt: null, expiresAt: { gt: clock.now() } } })
          : Promise.resolve(null),
        prisma.memberWorkState.groupBy({
          by: ['state'],
          where: { organizationId: ctx.orgId, ...memberFilter, member: { status: 'ACTIVE', memberType: 'EMPLOYEE' } },
          _count: { _all: true },
        }),
        prisma.timeEntry.findMany({
          where: { organizationId: ctx.orgId, ...memberFilter, deletedAt: null, startedAt: { gte: todayStart } },
          select: { startedAt: true, endedAt: true, durationS: true, isBillable: true },
        }),
        hasPermission(ctx, 'timesheets.approve') ? resolveMemberScope(prisma, ctx, 'timesheets.approve') : Promise.resolve(null),
        hasPermission(ctx, 'attendance.correct.approve') ? resolveMemberScope(prisma, ctx, 'attendance.correct.approve') : Promise.resolve(null),
      ]);
      const countFor = async (model, approverScope, extra) =>
        approverScope === null
          ? null
          : model.count({
              where: {
                organizationId: ctx.orgId,
                ...extra,
                userId: approverScope.all ? { not: ctx.userId } : { in: [...approverScope.userIds].filter((id) => id !== ctx.userId) },
              },
            });
      const [pendingTimesheets, pendingCorrections] = await Promise.all([
        countFor(prisma.timesheet, approvable, { status: 'SUBMITTED' }),
        countFor(prisma.attendanceCorrection, corrections, { status: 'PENDING' }),
      ]);
      // Projects and deadlines: within projects the viewer can see, for people in their scope.
      const orgToday = DateTime.fromJSDate(clock.now(), { zone: ctx.organization?.timeZone ?? 'UTC' });
      const todayDate = new Date(`${orgToday.toISODate()}T00:00:00Z`);
      const projectWhere = { ...readableProjectsWhere(ctx), archivedAt: null };
      const taskScope = {
        organizationId: ctx.orgId,
        archivedAt: null,
        project: projectWhere,
        status: { category: { in: ['TODO', 'IN_PROGRESS'] } },
        ...(scope.all ? {} : { assignees: { some: { userId: { in: [...scope.userIds] } } } }),
      };
      const [activeProjects, overdueTasks, upcoming] = await Promise.all([
        prisma.project.count({ where: { ...projectWhere, status: 'ACTIVE' } }),
        prisma.task.count({ where: { ...taskScope, dueDate: { lt: todayDate } } }),
        prisma.task.findMany({
          where: { ...taskScope, dueDate: { gte: todayDate, lte: new Date(todayDate.getTime() + 14 * 86_400_000) } },
          include: { project: { select: { code: true } } },
          orderBy: { dueDate: 'asc' },
          take: 6,
        }),
      ]);
      const now = clock.now();
      const live = (e) => (e.endedAt ? e.durationS : Math.max(0, Math.round((now - e.startedAt) / 1000)));
      const trackedS = entries.reduce((s, e) => s + live(e), 0);
      const billableS = entries.filter((e) => e.isBillable).reduce((s, e) => s + live(e), 0);
      const working = Object.fromEntries(states.map((s) => [s.state, s._count._all]));

      const headcount = { ACTIVE: 0, INVITED: 0, SUSPENDED: 0, DEACTIVATED: 0, ARCHIVED: 0 };
      for (const row of byStatus) headcount[row.status] = row._count._all;

      const departments = new Map();
      for (const p of activeProfiles) {
        const key = p.departmentId ?? 'unassigned';
        const entry = departments.get(key) ?? { departmentId: p.departmentId, name: p.department?.name ?? 'Unassigned', count: 0 };
        entry.count += 1;
        departments.set(key, entry);
      }
      const completion = activeProfiles.length
        ? Math.round(activeProfiles.reduce((sum, p) => sum + p.completionPct, 0) / activeProfiles.length)
        : null;

      return {
        scope: scope.all ? 'org' : [...ctx.permissions.get('dashboard.read')].join(','),
        generatedAt: clock.now().toISOString(),
        headcount,
        byDepartment: [...departments.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
        recentJoiners: recent.map((m) => ({ employeeId: m.id, name: m.user.name, designation: m.profile?.designation ?? null, joinedAt: m.joinedAt })),
        averageProfileCompletion: completion,
        pendingInvitations,
        presence: { working: working.WORKING ?? 0, onBreak: working.ON_BREAK ?? 0 },
        today: { trackedS, billableS, nonBillableS: trackedS - billableS, since: todayStart.toISOString() },
        pendingTimesheets,
        pendingCorrections,
        projects: { active: activeProjects, overdueTasks },
        upcomingDeadlines: upcoming.map((t) => ({ taskId: t.id, key: `${t.project.code}-${t.number}`, title: t.title, dueDate: t.dueDate.toISOString().slice(0, 10) })),
      };
    },
  };
}
