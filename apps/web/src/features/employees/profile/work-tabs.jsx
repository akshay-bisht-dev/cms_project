'use client';

import Link from 'next/link';
import { BriefcaseBusiness, ListTodo } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/common/states';
import { DataTable } from '@/components/data-tables/data-table';
import { ProjectStatusBadge, TaskStatusBadge } from '@/features/projects/badges';
import { useProjects, useTasks } from '@/features/projects/queries';
import { formatDate } from '@/lib/format';

/** Projects this employee belongs to that the viewer can also see. */
export function EmployeeProjects({ employeeId }) {
  const projects = useProjects({ memberEmployeeId: employeeId });
  return (
    <Card>
      <DataTable
        caption="Projects"
        columns={[
          { key: 'name', header: 'Project', cell: (p) => <Link href={`/projects/${p.id}/overview`} className="font-medium hover:underline">{p.code} · {p.name}</Link> },
          { key: 'status', header: 'Status', cell: (p) => <ProjectStatusBadge status={p.status} /> },
          { key: 'deadline', header: 'Deadline', cell: (p) => formatDate(p.deadline), className: 'hidden sm:table-cell' },
        ]}
        rows={projects.data ?? []}
        isPending={projects.isPending}
        error={projects.error}
        onRetry={() => projects.refetch()}
        empty={<EmptyState icon={BriefcaseBusiness} title="No shared projects" description="Only projects you can also see are listed." />}
      />
    </Card>
  );
}

/** Open tasks assigned to this employee in projects the viewer can see. */
export function EmployeeTasks({ employeeId }) {
  const tasks = useTasks({ assignee: employeeId, statusCategory: 'TODO,IN_PROGRESS', sort: 'dueDate' });
  return (
    <Card>
      <DataTable
        caption="Open tasks"
        columns={[
          { key: 'title', header: 'Task', cell: (t) => <Link href={`/tasks/${t.id}`} className="font-medium hover:underline"><span className="mr-2 text-xs font-normal text-muted-foreground">{t.key}</span>{t.title}</Link> },
          { key: 'status', header: 'Status', cell: (t) => <TaskStatusBadge status={t.status} /> },
          { key: 'due', header: 'Due', cell: (t) => formatDate(t.dueDate) },
        ]}
        rows={tasks.data?.data ?? []}
        isPending={tasks.isPending}
        error={tasks.error}
        onRetry={() => tasks.refetch()}
        empty={<EmptyState icon={ListTodo} title="No open tasks" />}
      />
    </Card>
  );
}
