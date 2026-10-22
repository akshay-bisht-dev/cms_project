'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { BriefcaseBusiness, CircleAlert, CircleUserRound, ClipboardCheck, Clock, Coffee, Mail, Timer, UserCheck, UserMinus } from 'lucide-react';
import { formatDate, formatDuration } from '@/lib/format';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { NativeSelect } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Avatar } from '@/components/ui/avatar';
import { PageHeader } from '@/components/common/page-header';
import { EmptyState, ErrorState } from '@/components/common/states';
import { useDepartments, useTeams } from '@/features/employees/queries';
import { useUrlState } from '@/hooks/use-url-state';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { DepartmentChart } from './department-chart';
import { StatTile } from './stat-tile';

const SCOPE_LABEL = { org: 'the whole organization', team: 'your teams', department: 'your departments', project: 'your projects', self: 'yourself' };

export function OrgDashboard() {
  const [filters, setFilters] = useUrlState({ departmentId: '', teamId: '' });
  const departments = useDepartments();
  const teams = useTeams();
  const query = Object.fromEntries(Object.entries(filters).filter(([, v]) => v));
  const summary = useQuery({
    queryKey: queryKeys.dashboard(query),
    queryFn: async () => (await api.get('/dashboard/summary', { query })).data,
    refetchInterval: 60_000,
  });
  const s = summary.data;
  const scope = s?.scope.split(',').map((x) => SCOPE_LABEL[x] ?? x).join(' and ');

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={s ? `Metrics for ${scope}.` : 'People and work metrics'}
      />
      <div className="mb-4 flex flex-wrap gap-3" role="group" aria-label="Dashboard filters">
        <NativeSelect aria-label="Department" className="w-auto min-w-48" value={filters.departmentId} onChange={(e) => setFilters({ departmentId: e.target.value })}>
          <option value="">All departments</option>
          {departments.data?.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect aria-label="Team" className="w-auto min-w-48" value={filters.teamId} onChange={(e) => setFilters({ teamId: e.target.value })}>
          <option value="">All teams</option>
          {teams.data?.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </NativeSelect>
      </div>

      {summary.error ? (
        <Card>
          <ErrorState error={summary.error} onRetry={() => summary.refetch()} />
        </Card>
      ) : (
        <div className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {summary.isPending ? (
              Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-28" />)
            ) : (
              <>
                <StatTile label="Active employees" icon={UserCheck} value={s.headcount.ACTIVE} basis="Members with an active account" />
                <StatTile label="Invited" icon={Mail} value={s.headcount.INVITED} basis="Invited, not yet joined" />
                <StatTile label="Deactivated" icon={UserMinus} value={s.headcount.DEACTIVATED} basis="Deactivated or offboarded, not archived" />
                <StatTile
                  label="Profile completion"
                  icon={CircleUserRound}
                  value={s.averageProfileCompletion === null ? null : `${s.averageProfileCompletion}%`}
                  basis="Average across active employees"
                />
              </>
            )}
          </div>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {summary.isPending ? (
              Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-28" />)
            ) : (
              <>
                <StatTile label="Working now" icon={Clock} value={s.presence.working} basis="Clocked in at this moment" />
                <StatTile label="On break" icon={Coffee} value={s.presence.onBreak} basis="On a break at this moment" />
                <StatTile
                  label="Tracked today"
                  icon={Timer}
                  value={formatDuration(s.today.trackedS)}
                  basis={`${formatDuration(s.today.billableS)} billable · ${formatDuration(s.today.nonBillableS)} non-billable`}
                />
                <StatTile
                  label="Waiting for approval"
                  icon={ClipboardCheck}
                  value={s.pendingTimesheets === null ? '—' : s.pendingTimesheets + (s.pendingCorrections ?? 0)}
                  basis={
                    s.pendingTimesheets === null ? 'You do not approve timesheets' : `${s.pendingTimesheets} timesheets · ${s.pendingCorrections ?? 0} corrections`
                  }
                />
              </>
            )}
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            {summary.isPending ? (
              <Skeleton className="h-40 lg:col-span-3" />
            ) : (
              <>
                <StatTile label="Active projects" icon={BriefcaseBusiness} value={s.projects.active} basis="Projects you can see with status Active" />
                <StatTile label="Overdue tasks" icon={CircleAlert} value={s.projects.overdueTasks} basis="Open tasks past their due date, in your scope" />
                <Card>
                  <CardHeader>
                    <CardTitle>Upcoming deadlines</CardTitle>
                    <CardDescription>Next 14 days</CardDescription>
                  </CardHeader>
                  <CardContent>
                    {s.upcomingDeadlines.length ? (
                      <ul className="grid gap-2 text-sm">
                        {s.upcomingDeadlines.map((d) => (
                          <li key={d.taskId} className="flex gap-2">
                            <Link href={`/tasks/${d.taskId}`} className="min-w-0 flex-1 truncate hover:underline">
                              <span className="mr-1 text-xs text-muted-foreground">{d.key}</span>
                              {d.title}
                            </Link>
                            <span className="text-xs text-muted-foreground">{formatDate(d.dueDate)}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-sm text-muted-foreground">Nothing due in the next two weeks.</p>
                    )}
                  </CardContent>
                </Card>
              </>
            )}
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Active people by department</CardTitle>
                <CardDescription>Headcount of active members, grouped by their department.</CardDescription>
              </CardHeader>
              <CardContent>
                {summary.isPending ? (
                  <Skeleton className="h-48" />
                ) : s.byDepartment.length ? (
                  <DepartmentChart data={s.byDepartment} />
                ) : (
                  <EmptyState title="No active employees in this view" />
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Recently joined</CardTitle>
                <CardDescription>Last 30 days</CardDescription>
              </CardHeader>
              <CardContent>
                {summary.isPending ? (
                  <Skeleton className="h-40" />
                ) : s.recentJoiners.length ? (
                  <ul className="grid gap-3">
                    {s.recentJoiners.map((p) => (
                      <li key={p.employeeId}>
                        <Link href={`/employees/${p.employeeId}`} className="flex items-center gap-3 rounded-md hover:bg-muted">
                          <Avatar name={p.name} size="sm" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium">{p.name}</span>
                            <span className="block truncate text-xs text-muted-foreground">{p.designation ?? 'No designation'}</span>
                          </span>
                          <span className="text-xs text-muted-foreground">{formatDate(p.joinedAt)}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-muted-foreground">No one joined in the last 30 days.</p>
                )}
                {s?.pendingInvitations !== null && s?.pendingInvitations !== undefined && (
                  <p className="mt-4 border-t pt-3 text-sm">
                    <span className="font-semibold tabular-nums">{s.pendingInvitations}</span> pending{' '}
                    {s.pendingInvitations === 1 ? 'invitation' : 'invitations'}
                  </p>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
