'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { History } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/common/states';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { queryKeys } from '@/lib/query-keys';

const FIELD_LABELS = {
  name: 'Name', employeeCode: 'Employee ID', designation: 'Designation', departmentId: 'Department', managerEmployeeId: 'Manager',
  employmentType: 'Employment type', joiningDate: 'Joining date', workLocation: 'Work location', timeZone: 'Time zone', skills: 'Skills',
  phone: 'Phone', personalEmail: 'Personal email', address: 'Address', emergencyContact: 'Emergency contact',
  probationEndDate: 'Probation end', noticePeriodDays: 'Notice period', lastWorkingDate: 'Last working day',
};

export function ActivityTab({ employee }) {
  const history = useInfiniteQuery({
    queryKey: queryKeys.employeeHistory(employee.employeeId),
    queryFn: ({ pageParam }) => api.get(`/employees/${employee.employeeId}/history`, { query: { cursor: pageParam, limit: 25 } }),
    initialPageParam: undefined,
    getNextPageParam: (last) => last.meta.page.nextCursor ?? undefined,
  });
  const items = history.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile changes</CardTitle>
        <CardDescription>Who changed which field, and when. Sensitive values are hidden. Work activity (time, attendance) arrives in Phase 8.</CardDescription>
      </CardHeader>
      <CardContent>
        {history.isPending ? (
          <div className="space-y-3">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : history.error ? (
          history.error.status === 403 ? (
            <EmptyState icon={History} title="History is restricted" description="You do not have permission to view this employee's change history." />
          ) : (
            <ErrorState error={history.error} onRetry={() => history.refetch()} />
          )
        ) : items.length === 0 ? (
          <EmptyState icon={History} title="No changes recorded yet" />
        ) : (
          <ol className="relative space-y-4 border-l pl-6">
            {items.map((h) => (
              <li key={h.id} className="relative">
                <span aria-hidden className="absolute top-1.5 -left-[29px] size-2.5 rounded-full border-2 border-card bg-primary" />
                <p className="text-sm">
                  <span className="font-medium">{FIELD_LABELS[h.field] ?? h.field}</span>
                  {h.oldValue !== null && (
                    <>
                      {' '}from <span className="rounded bg-muted px-1">{h.oldValue}</span>
                    </>
                  )}{' '}
                  to <span className="rounded bg-muted px-1">{h.newValue ?? 'empty'}</span>
                </p>
                <p className="text-xs text-muted-foreground">{formatDate(h.createdAt, { withTime: true })}</p>
              </li>
            ))}
          </ol>
        )}
        {history.hasNextPage && (
          <Button variant="outline" size="sm" className="mt-4" onClick={() => history.fetchNextPage()} disabled={history.isFetchingNextPage}>
            Load more
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
