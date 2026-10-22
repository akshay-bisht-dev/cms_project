import { localDateRange } from '../../utils/time.js';
import { ForbiddenError } from '../../utils/errors.js';
import { coversMember, resolveMemberScope } from '../rbac/rbac.service.js';
import { resolveEmployeeUserId } from '../shared/members.js';
import { readableProjectsWhere } from '../projects/access.js';
import { emptyTotals, finishTotals, mergeTotals, ratio } from '../activity/kpi.js';
import { aggregateStats, datesBetween, ensureStats, trackedTimeByProject } from '../activity/stats.js';
import { BUSINESS_REPORTS } from './business-reports.js';

// Column: { key, label, kind: measured|derived|estimated, type: text|date|count|duration|percent }
const col = (key, label, kind, type) => ({ key, label, kind, type });
const LABEL = (label) => col('label', label, null, 'text');

/** Members whose data a report covers: the permission's scope narrowed by optional filters. */
export async function scopedMembers(db, ctx, permission, { employeeId, teamId, departmentId } = {}) {
  const scope = await resolveMemberScope(db, ctx, permission);
  const where = { organizationId: ctx.orgId, memberType: 'EMPLOYEE', status: { in: ['ACTIVE', 'SUSPENDED', 'DEACTIVATED'] } };
  if (!scope.all) where.userId = { in: [...scope.userIds] };
  if (employeeId) {
    const userId = await resolveEmployeeUserId(db, ctx.orgId, employeeId, 'query.employeeId');
    if (!(await coversMember(db, ctx, permission, userId))) throw new ForbiddenError('This person is outside what you can report on');
    where.userId = userId;
  }
  if (teamId) where.teamMemberships = { some: { teamId } };
  if (departmentId) where.profile = { departmentId };
  const members = await db.organizationMember.findMany({ where, select: { id: true, userId: true, user: { select: { name: true } } }, orderBy: { user: { name: 'asc' } } });
  return members.map((m) => ({ userId: m.userId, employeeId: m.id, name: m.user.name }));
}

/** Per-member or per-day totals for a report, aggregated by the database (kpi formulas applied on top). */
async function statsTotals(db, ctx, members, params, now) {
  const dates = datesBetween(params.from, params.to);
  const userIds = members.map((m) => m.userId);
  const { complete } = await ensureStats(db, { organizationId: ctx.orgId, userIds, dates, now, budget: params.budget });
  const groups = await aggregateStats(db, { organizationId: ctx.orgId, userIds, from: params.from, to: params.to, by: params.groupBy === 'day' ? 'date' : 'user' });
  const totals = finishTotals([...groups.values()].reduce((t, g) => mergeTotals(t, g), emptyTotals()));
  return { groups, totals, complete };
}

/** One row per member (everyone in scope, even with no data) or per day that has data. */
function grouped(groups, members, groupBy) {
  if (groupBy === 'day') return [...groups.keys()].sort().map((day) => ({ label: day, ...finishTotals(groups.get(day)) }));
  return members.map((m) => ({ label: m.name, employeeId: m.employeeId, ...finishTotals(groups.get(m.userId) ?? emptyTotals()) }));
}

function report(def, params, { columns, rows, totals, complete = true, notes = [] }) {
  return {
    type: def.type,
    title: def.title,
    columns,
    rows: rows.map((r) => Object.fromEntries([...columns.map((c) => [c.key, r[c.key] ?? null]), ...(r.employeeId ? [['employeeId', r.employeeId]] : [])])),
    totals: totals ? Object.fromEntries(columns.filter((c) => c.type !== 'text').map((c) => [c.key, totals[c.key] ?? null])) : null,
    meta: { from: params.from, to: params.to, groupBy: params.groupBy ?? null, complete, notes },
  };
}

const INCOMPLETE = 'Some days were still being calculated; figures may be incomplete. Try again shortly or export the report.';

export const REPORTS = {
  attendance: {
    type: 'attendance',
    title: 'Attendance',
    description: 'Scheduled and present days, lateness, hours worked, breaks and overtime.',
    permission: 'reports.attendance.read',
    groupBy: ['member', 'day'],
    async run(db, ctx, params, now) {
      const members = await scopedMembers(db, ctx, this.permission, params);
      const { groups, totals, complete } = await statsTotals(db, ctx, members, params, now);
      const columns = [
        LABEL(params.groupBy === 'day' ? 'Date' : 'Employee'),
        col('scheduledDays', 'Scheduled days', 'measured', 'count'),
        col('presentDays', 'Days present', 'measured', 'count'),
        col('absentDays', 'Days absent', 'derived', 'count'),
        col('lateDays', 'Late days', 'derived', 'count'),
        col('workedS', 'Worked', 'measured', 'duration'),
        col('breakS', 'Breaks', 'measured', 'duration'),
        col('overtimeS', 'Overtime', 'derived', 'duration'),
        col('attendanceRate', 'Attendance rate', 'derived', 'percent'),
      ];
      return report(this, params, { columns, rows: grouped(groups, members, params.groupBy), totals, complete, notes: complete ? [] : [INCOMPLETE] });
    },
  },

  time: {
    type: 'time',
    title: 'Time & utilization',
    description: 'Tracked, billable and non-billable time, utilization against scheduled time, and time by project.',
    permission: 'reports.attendance.read',
    groupBy: ['member', 'project', 'day'],
    async run(db, ctx, params, now) {
      const members = await scopedMembers(db, ctx, this.permission, params);
      if (params.groupBy === 'project') {
        const zone = ctx.organization?.timeZone ?? 'UTC';
        const [start, end] = localDateRange(params.from, params.to, zone);
        const { byProject, trackedS, billableS, people: totalPeople } = await trackedTimeByProject(db, { organizationId: ctx.orgId, userIds: members.map((m) => m.userId), start, end, now });
        const projects = await db.project.findMany({ where: { organizationId: ctx.orgId, id: { in: byProject.map((p) => p.projectId).filter(Boolean) } }, select: { id: true, code: true, name: true } });
        const names = new Map(projects.map((p) => [p.id, `${p.code} · ${p.name}`]));
        const rows = byProject
          .map((p) => ({ label: p.projectId ? (names.get(p.projectId) ?? 'Unknown project') : 'No project', trackedS: p.trackedS, billableS: p.billableS, nonBillableS: p.trackedS - p.billableS, billableShare: ratio(p.billableS, p.trackedS), people: p.people }))
          .sort((a, b) => b.trackedS - a.trackedS);
        const columns = [
          LABEL('Project'),
          col('trackedS', 'Tracked', 'measured', 'duration'),
          col('billableS', 'Billable', 'measured', 'duration'),
          col('nonBillableS', 'Non-billable', 'measured', 'duration'),
          col('billableShare', 'Billable share', 'derived', 'percent'),
          col('people', 'People', 'measured', 'count'),
        ];
        return report(this, params, { columns, rows, totals: { trackedS, billableS, nonBillableS: trackedS - billableS, billableShare: ratio(billableS, trackedS), people: totalPeople }, notes: [`Days in ${zone}.`] });
      }
      const { groups, totals, complete } = await statsTotals(db, ctx, members, params, now);
      const columns = [
        LABEL(params.groupBy === 'day' ? 'Date' : 'Employee'),
        col('trackedS', 'Tracked', 'measured', 'duration'),
        col('billableS', 'Billable', 'measured', 'duration'),
        col('nonBillableS', 'Non-billable', 'measured', 'duration'),
        col('scheduledS', 'Scheduled', 'measured', 'duration'),
        col('utilization', 'Billable utilization', 'derived', 'percent'),
        col('billableShare', 'Billable share', 'derived', 'percent'),
        col('tasksCompleted', 'Tasks completed', 'measured', 'count'),
      ];
      return report(this, params, { columns, rows: grouped(groups, members, params.groupBy), totals, complete, notes: complete ? [] : [INCOMPLETE] });
    },
  },

  projects: {
    type: 'projects',
    title: 'Projects',
    description: 'Time against estimates, billable share and task throughput per project.',
    permission: 'reports.projects.read',
    groupBy: ['project'],
    async run(db, ctx, params, now) {
      const members = await scopedMembers(db, ctx, this.permission, params);
      const zone = ctx.organization?.timeZone ?? 'UTC';
      const [start, end] = localDateRange(params.from, params.to, zone);
      const today = new Date(`${new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(now)}T00:00:00Z`);
      const projects = await db.project.findMany({ where: { ...readableProjectsWhere(ctx), archivedAt: null }, select: { id: true, code: true, name: true, status: true, estimatedS: true }, orderBy: { code: 'asc' } });
      const ids = projects.map((p) => p.id);
      const [tracked, completed, open] = await Promise.all([
        trackedTimeByProject(db, { organizationId: ctx.orgId, userIds: members.map((m) => m.userId), projectIds: ids, start, end, now }),
        ids.length ? db.task.groupBy({ by: ['projectId'], where: { organizationId: ctx.orgId, projectId: { in: ids }, completedAt: { gte: start, lt: end } }, _count: { _all: true } }) : [],
        ids.length ? db.task.findMany({ where: { organizationId: ctx.orgId, projectId: { in: ids }, archivedAt: null, completedAt: null }, select: { projectId: true, dueDate: true } }) : [],
      ]);
      const time = new Map(tracked.byProject.map((p) => [p.projectId, p]));
      const done = new Map(completed.map((c) => [c.projectId, c._count._all]));
      const rows = projects.map((p) => {
        const t = time.get(p.id) ?? { trackedS: 0, billableS: 0 };
        const openTasks = open.filter((o) => o.projectId === p.id);
        return {
          label: `${p.code} · ${p.name}`,
          status: p.status,
          trackedS: t.trackedS,
          billableS: t.billableS,
          estimatedS: p.estimatedS,
          hoursUtilization: p.estimatedS ? ratio(t.trackedS, p.estimatedS) : null,
          tasksCompleted: done.get(p.id) ?? 0,
          openTasks: openTasks.length,
          overdueTasks: openTasks.filter((o) => o.dueDate && o.dueDate < today).length,
        };
      });
      const columns = [
        LABEL('Project'),
        col('status', 'Status', null, 'text'),
        col('trackedS', 'Tracked in period', 'measured', 'duration'),
        col('billableS', 'Billable in period', 'measured', 'duration'),
        col('estimatedS', 'Estimate (whole project)', 'measured', 'duration'),
        col('hoursUtilization', 'Tracked ÷ estimate', 'derived', 'percent'),
        col('tasksCompleted', 'Tasks completed', 'measured', 'count'),
        col('openTasks', 'Open tasks', 'measured', 'count'),
        col('overdueTasks', 'Overdue now', 'measured', 'count'),
      ];
      const sum = (k) => rows.reduce((s, r) => s + (r[k] ?? 0), 0);
      const totals = { trackedS: sum('trackedS'), billableS: sum('billableS'), estimatedS: sum('estimatedS'), tasksCompleted: sum('tasksCompleted'), openTasks: sum('openTasks'), overdueTasks: sum('overdueTasks') };
      return report(this, params, { columns, rows, totals, notes: ['Tracked ÷ estimate compares time in this period with the whole-project estimate.', `Days in ${zone}.`] });
    },
  },

  monitoring: {
    type: 'monitoring',
    title: 'Screenshot coverage',
    description: 'Captures received against captures expected while monitored, upload failures and idle time. Not a measure of productivity.',
    permission: 'reports.monitoring.read',
    groupBy: ['member', 'day'],
    async run(db, ctx, params, now) {
      const members = await scopedMembers(db, ctx, this.permission, params);
      const { groups, totals, complete } = await statsTotals(db, ctx, members, params, now);
      const columns = [
        LABEL(params.groupBy === 'day' ? 'Date' : 'Employee'),
        col('monitoredS', 'Monitored time', 'derived', 'duration'),
        col('screenshotsExpected', 'Expected captures', 'derived', 'count'),
        col('screenshotsOk', 'Received', 'measured', 'count'),
        col('screenshotsFailed', 'Failed or missing', 'measured', 'count'),
        col('coverage', 'Coverage', 'derived', 'percent'),
        col('failureRate', 'Failure rate', 'measured', 'percent'),
        col('idleS', 'Idle (no input)', 'measured', 'duration'),
      ];
      const notes = ['Coverage = received ÷ expected; expected = monitored time ÷ capture interval.', 'Counts describe the capture pipeline, not how much anyone worked.'];
      return report(this, params, { columns, rows: grouped(groups, members, params.groupBy), totals, complete, notes: complete ? notes : [...notes, INCOMPLETE] });
    },
  },
};

Object.assign(REPORTS, BUSINESS_REPORTS);

export const REPORT_TYPES = Object.keys(REPORTS);
