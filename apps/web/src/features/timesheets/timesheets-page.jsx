'use client';

import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardList, Send } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/common/page-header';
import { EmptyState, ErrorState } from '@/components/common/states';
import { DataTable } from '@/components/data-tables/data-table';
import { StatTile } from '@/features/dashboard/stat-tile';
import { useCan } from '@/features/session/session-provider';
import { useUrlState } from '@/hooks/use-url-state';
import { api } from '@/lib/api';
import { formatDate, formatDuration } from '@/lib/format';
import { queryKeys } from '@/lib/query-keys';
import { cn } from '@/lib/utils';
import { TimesheetStatus } from './timesheet-badges';

const period = (t) => `${formatDate(t.periodStart)} – ${formatDate(t.periodEnd)}`;

function CurrentPeriod() {
  const queryClient = useQueryClient();
  const canSubmit = useCan('timesheets.submit');
  const current = useQuery({ queryKey: queryKeys.timesheets({ current: true }), queryFn: async () => (await api.post('/timesheets', {})).data, enabled: canSubmit });
  const submit = useMutation({
    mutationFn: (id) => api.post(`/timesheets/${id}/submit`, undefined, { idempotencyKey: crypto.randomUUID() }),
    onSuccess: () => {
      toast.success('Timesheet submitted for approval');
      queryClient.invalidateQueries({ queryKey: ['timesheets'] });
      queryClient.invalidateQueries({ queryKey: ['time-entries'] });
    },
    onError: (error) => toast.error(error.message),
  });
  if (!canSubmit) return null;
  if (current.isPending) return <Skeleton className="mb-4 h-40" />;
  if (current.error) return <ErrorState error={current.error} onRetry={() => current.refetch()} />;
  const t = current.data;
  return (
    <Card className="mb-4">
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-2">
        <div>
          <CardTitle>This period</CardTitle>
          <CardDescription>{period(t)}</CardDescription>
        </div>
        <TimesheetStatus status={t.status} />
      </CardHeader>
      <CardContent>
        <div className="mb-4 grid gap-4 sm:grid-cols-3">
          <StatTile label="Total" value={formatDuration(t.totalS)} basis="Completed entries in this period" />
          <StatTile label="Billable" value={formatDuration(t.billableS)} basis="Marked billable" />
          <StatTile label="Non-billable" value={formatDuration(t.totalS - t.billableS)} basis="Total minus billable" />
        </div>
        <div className="flex flex-wrap gap-2">
          {['DRAFT', 'REJECTED'].includes(t.status) && (
            <Button onClick={() => submit.mutate(t.id)} disabled={submit.isPending || t.totalS === 0}>
              <Send aria-hidden /> Submit for approval
            </Button>
          )}
          <Button variant="outline" asChild>
            <Link href={`/timesheets/${t.id}`}>Review entries</Link>
          </Button>
        </div>
        {t.totalS === 0 && <p className="mt-2 text-sm text-muted-foreground">Nothing tracked in this period yet. Running timers are added once stopped.</p>}
      </CardContent>
    </Card>
  );
}

function TimesheetTable({ view }) {
  const params = { view };
  const list = useQuery({ queryKey: queryKeys.timesheets(params), queryFn: async () => (await api.get('/timesheets', { query: params })).data });
  const columns = [
    ...(view === 'approvals' ? [{ key: 'employee', header: 'Employee', cell: (t) => <span className="font-medium">{t.employee?.name}</span> }] : []),
    { key: 'period', header: 'Period', cell: (t) => <Link href={`/timesheets/${t.id}`} className="font-medium text-primary hover:underline">{period(t)}</Link> },
    { key: 'total', header: 'Total', cell: (t) => <span className="tabular-nums">{formatDuration(t.totalS)}</span> },
    { key: 'billable', header: 'Billable', cell: (t) => <span className="tabular-nums">{formatDuration(t.billableS)}</span>, className: 'hidden sm:table-cell' },
    { key: 'status', header: 'Status', cell: (t) => <TimesheetStatus status={t.status} /> },
  ];
  return (
    <Card>
      <DataTable
        caption={view === 'approvals' ? 'Timesheets awaiting approval' : 'My timesheets'}
        columns={columns}
        rows={list.data ?? []}
        isPending={list.isPending}
        error={list.error}
        onRetry={() => list.refetch()}
        empty={<EmptyState icon={ClipboardList} title={view === 'approvals' ? 'No timesheets waiting for you' : 'No timesheets yet'} />}
      />
    </Card>
  );
}

export function TimesheetsPage() {
  const canApprove = useCan('timesheets.approve');
  const [{ view }, setView] = useUrlState({ view: 'mine' });
  const active = view === 'approvals' && canApprove ? 'approvals' : 'mine';
  return (
    <>
      <PageHeader title="Timesheets" description="Submit your tracked time for each period. Approved periods are locked." />
      {canApprove && (
        <div role="tablist" aria-label="Timesheet views" className="mb-4 flex gap-1 border-b">
          {[
            ['mine', 'Mine'],
            ['approvals', 'To approve'],
          ].map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={active === id}
              onClick={() => setView({ view: id })}
              className={cn('h-10 border-b-2 px-3 text-sm', active === id ? 'border-primary font-medium text-primary' : 'border-transparent text-muted-foreground hover:text-foreground')}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {active === 'mine' && <CurrentPeriod />}
      <TimesheetTable view={active} />
    </>
  );
}

/** Timesheets of one employee (profile tab). */
export function EmployeeTimesheets({ employeeId }) {
  const list = useQuery({ queryKey: queryKeys.timesheets({ employeeId }), queryFn: async () => (await api.get('/timesheets', { query: { employeeId } })).data });
  if (list.error?.status === 404 || list.error?.status === 403) {
    return <Card><EmptyState icon={ClipboardList} title="Timesheets are restricted" description="You do not have permission to view this employee’s timesheets." /></Card>;
  }
  return (
    <Card>
      <DataTable
        caption="Timesheets"
        columns={[
          { key: 'period', header: 'Period', cell: (t) => <Link href={`/timesheets/${t.id}`} className="font-medium text-primary hover:underline">{period(t)}</Link> },
          { key: 'total', header: 'Total', cell: (t) => formatDuration(t.totalS) },
          { key: 'status', header: 'Status', cell: (t) => <TimesheetStatus status={t.status} /> },
        ]}
        rows={list.data ?? []}
        isPending={list.isPending}
        error={list.error}
        onRetry={() => list.refetch()}
        empty={<EmptyState icon={ClipboardList} title="No timesheets yet" />}
      />
    </Card>
  );
}
