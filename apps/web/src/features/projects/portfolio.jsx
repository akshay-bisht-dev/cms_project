'use client';

import Link from 'next/link';
import { useQueries } from '@tanstack/react-query';
import { FolderKanban } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/common/page-header';
import { EmptyState } from '@/components/common/states';
import { DataTable } from '@/components/data-tables/data-table';
import { api } from '@/lib/api';
import { formatDate, formatDuration } from '@/lib/format';
import { ProjectStatusBadge } from './badges';
import { ProgressBar } from './projects-page';
import { projectKeys, useProjects } from './queries';

/** Portfolio health: every open project with progress, hours against estimate and overdue work. */
export function Portfolio() {
  const projects = useProjects({ status: 'PLANNED,ACTIVE,ON_HOLD' });
  const summaries = useQueries({
    queries: (projects.data ?? []).map((p) => ({ queryKey: projectKeys.summary(p.id), queryFn: async () => (await api.get(`/projects/${p.id}/summary`)).data })),
  });
  const summaryOf = Object.fromEntries((projects.data ?? []).map((p, i) => [p.id, summaries[i]?.data]));
  const columns = [
    {
      key: 'name',
      header: 'Project',
      cell: (p) => (
        <Link href={`/projects/${p.id}/overview`} className="font-medium hover:underline">
          {p.name}
          <span className="block text-xs font-normal text-muted-foreground">{p.code}</span>
        </Link>
      ),
    },
    { key: 'status', header: 'Status', cell: (p) => <ProjectStatusBadge status={p.status} /> },
    {
      key: 'progress',
      header: 'Tasks done',
      cell: (p) => (
        <div className="w-32">
          <ProgressBar value={p.taskCounts.total ? (p.taskCounts.done / p.taskCounts.total) * 100 : 0} label={`${p.name} progress`} />
          <span className="text-xs text-muted-foreground">
            {p.taskCounts.done}/{p.taskCounts.total}
          </span>
        </div>
      ),
    },
    {
      key: 'hours',
      header: 'Hours vs estimate',
      className: 'hidden md:table-cell',
      cell: (p) => {
        const s = summaryOf[p.id];
        if (!s) return <span className="text-muted-foreground">…</span>;
        return (
          <span className="tabular-nums">
            {formatDuration(s.hours.actualS)}
            {s.hours.estimatedS ? ` / ${formatDuration(s.hours.estimatedS)} (${s.hours.utilization}%)` : ' · no estimate'}
          </span>
        );
      },
    },
    { key: 'overdue', header: 'Overdue', cell: (p) => <span className="tabular-nums">{summaryOf[p.id]?.tasks.overdue ?? '…'}</span> },
    { key: 'deadline', header: 'Deadline', className: 'hidden lg:table-cell', cell: (p) => formatDate(p.deadline) },
    { key: 'manager', header: 'Manager', className: 'hidden lg:table-cell', cell: (p) => p.manager?.name ?? '—' },
  ];
  return (
    <>
      <PageHeader title="Project management" description="Health of every open project you can see. Hours come from tracked time; utilization = tracked ÷ estimate." />
      <Card>
        <DataTable
          caption="Project portfolio"
          columns={columns}
          rows={projects.data ?? []}
          isPending={projects.isPending}
          error={projects.error}
          onRetry={() => projects.refetch()}
          empty={<EmptyState icon={FolderKanban} title="No open projects" />}
        />
      </Card>
    </>
  );
}
