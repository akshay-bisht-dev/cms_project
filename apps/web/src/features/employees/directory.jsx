'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Download, Search, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input, NativeSelect } from '@/components/ui/input';
import { Avatar } from '@/components/ui/avatar';
import { Can } from '@/components/common/can';
import { PageHeader } from '@/components/common/page-header';
import { EmptyState } from '@/components/common/states';
import { MemberStatusBadge } from '@/components/common/status-badge';
import { CursorPagination, DataTable } from '@/components/data-tables/data-table';
import { useDebounce } from '@/hooks/use-debounce';
import { useUrlState } from '@/hooks/use-url-state';
import { API_PREFIX } from '@orbit/shared-constants';
import { InviteEmployeeDialog } from './invite-dialog';
import { useDepartments, useEmployees, useRoles, useTeams } from './queries';

const FILTER_DEFAULTS = { q: '', departmentId: '', teamId: '', roleId: '', status: 'ACTIVE,INVITED', sort: 'name' };
const PAGE_SIZE = 25;

export function EmployeeDirectory() {
  const [filters, setFilters] = useUrlState(FILTER_DEFAULTS);
  const [search, setSearch] = useState(filters.q);
  const debouncedSearch = useDebounce(search);

  useEffect(() => {
    if (debouncedSearch !== filters.q) setFilters({ q: debouncedSearch });
  }, [debouncedSearch, filters.q, setFilters]);

  // Pagination belongs to one filter combination: when filters change, paging restarts at page 1.
  const filterKey = JSON.stringify(filters);
  const [paging, setPaging] = useState({ key: filterKey, cursors: [], cursor: undefined });
  const { cursors, cursor } = paging.key === filterKey ? paging : { cursors: [], cursor: undefined };

  const query = useMemo(
    () => Object.fromEntries(Object.entries({ ...filters, cursor, limit: PAGE_SIZE }).filter(([, v]) => v !== '' && v !== undefined)),
    [filters, cursor],
  );
  const employees = useEmployees(query);
  const departments = useDepartments();
  const teams = useTeams();
  const roles = useRoles();
  const exportHref = `${API_PREFIX}/employees/export?${new URLSearchParams(Object.fromEntries(Object.entries(filters).filter(([, v]) => v))).toString()}`;

  const columns = [
    {
      key: 'name',
      header: 'Name',
      sortKey: 'name',
      cell: (e) => (
        <Link href={`/employees/${e.employeeId}`} className="flex items-center gap-3 font-medium hover:underline">
          <Avatar name={e.name} size="sm" />
          <span className="min-w-0">
            <span className="block truncate">{e.name}</span>
            <span className="block truncate text-xs font-normal text-muted-foreground">{e.email}</span>
          </span>
        </Link>
      ),
    },
    { key: 'designation', header: 'Designation', cell: (e) => e.designation ?? <span className="text-muted-foreground">—</span>, className: 'hidden md:table-cell' },
    { key: 'department', header: 'Department', cell: (e) => e.department?.name ?? <span className="text-muted-foreground">—</span>, className: 'hidden lg:table-cell' },
    { key: 'teams', header: 'Teams', cell: (e) => e.teams.map((t) => t.name).join(', ') || <span className="text-muted-foreground">—</span>, className: 'hidden xl:table-cell' },
    { key: 'roles', header: 'Roles', cell: (e) => e.roles.map((r) => r.name).join(', '), className: 'hidden lg:table-cell' },
    { key: 'status', header: 'Status', cell: (e) => <MemberStatusBadge status={e.status} /> },
  ];

  const hasFilters = Object.entries(filters).some(([k, v]) => k !== 'sort' && v !== FILTER_DEFAULTS[k]);

  return (
    <>
      <PageHeader
        title="People"
        description="Everyone in your organization you are allowed to see."
        actions={
          <>
            <Can permission="employees.export">
              <Button variant="outline" asChild>
                <a href={exportHref} download>
                  <Download aria-hidden /> Export CSV
                </a>
              </Button>
            </Can>
            <Can permission="employees.create">
              <InviteEmployeeDialog />
            </Can>
          </>
        }
      />
      <Card>
        <div className="grid gap-3 border-b p-4 sm:grid-cols-2 lg:grid-cols-5" role="search" aria-label="Filter employees">
          <div className="relative sm:col-span-2 lg:col-span-1">
            <Search className="pointer-events-none absolute top-2.5 left-3 size-4 text-muted-foreground" aria-hidden />
            <Input aria-label="Search by name, email, ID, designation or phone" placeholder="Search people" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
          </div>
          <NativeSelect aria-label="Department" value={filters.departmentId} onChange={(e) => setFilters({ departmentId: e.target.value })}>
            <option value="">All departments</option>
            {departments.data?.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </NativeSelect>
          <NativeSelect aria-label="Team" value={filters.teamId} onChange={(e) => setFilters({ teamId: e.target.value })}>
            <option value="">All teams</option>
            {teams.data?.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </NativeSelect>
          <NativeSelect aria-label="Role" value={filters.roleId} onChange={(e) => setFilters({ roleId: e.target.value })}>
            <option value="">All roles</option>
            {roles.data?.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </NativeSelect>
          <NativeSelect aria-label="Status" value={filters.status} onChange={(e) => setFilters({ status: e.target.value })}>
            <option value="ACTIVE,INVITED">Active & invited</option>
            <option value="ACTIVE">Active</option>
            <option value="INVITED">Invited</option>
            <option value="DEACTIVATED">Deactivated</option>
            <option value="ARCHIVED">Archived</option>
            <option value="ALL">All statuses</option>
          </NativeSelect>
        </div>
        <DataTable
          caption="Employees"
          columns={columns}
          rows={employees.data?.data ?? []}
          rowKey="employeeId"
          isPending={employees.isPending}
          error={employees.error}
          onRetry={() => employees.refetch()}
          sort={filters.sort}
          onSortChange={(sort) => setFilters({ sort })}
          empty={
            <EmptyState
              icon={Users}
              title={hasFilters ? 'No one matches these filters' : 'No employees yet'}
              description={hasFilters ? 'Try a different search or clear the filters.' : 'Invite your team to get started.'}
              action={
                hasFilters ? (
                  <Button
                    variant="outline"
                    onClick={() => {
                      setSearch('');
                      setFilters({ q: '', departmentId: '', teamId: '', roleId: '', status: FILTER_DEFAULTS.status });
                    }}
                  >
                    Clear filters
                  </Button>
                ) : null
              }
            />
          }
        />
        {(cursors.length > 0 || employees.data?.meta.page.nextCursor) && (
          <CursorPagination
            cursors={cursors}
            nextCursor={employees.data?.meta.page.nextCursor}
            isFetching={employees.isFetching}
            onNext={() => setPaging({ key: filterKey, cursors: [...cursors, cursor], cursor: employees.data.meta.page.nextCursor })}
            onPrevious={() => setPaging({ key: filterKey, cursors: cursors.slice(0, -1), cursor: cursors.at(-1) })}
          />
        )}
      </Card>
    </>
  );
}
