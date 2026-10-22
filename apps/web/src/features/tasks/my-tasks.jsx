'use client';

import Link from 'next/link';
import { ListTodo } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { NativeSelect } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/common/page-header';
import { EmptyState, ErrorState } from '@/components/common/states';
import { PriorityLabel, TaskStatusBadge } from '@/features/projects/badges';
import { useTasks } from '@/features/projects/queries';
import { useMe } from '@/features/session/session-provider';
import { useUrlState } from '@/hooks/use-url-state';
import { addDays, formatDate, todayIn } from '@/lib/format';

const GROUPS = [
  { id: 'overdue', label: 'Overdue' },
  { id: 'week', label: 'Due this week' },
  { id: 'later', label: 'Later' },
  { id: 'none', label: 'No due date' },
];

export function MyTasks() {
  const me = useMe();
  const today = todayIn(me.organization.timeZone);
  const [{ show }, setFilters] = useUrlState({ show: 'open' });
  const tasks = useTasks({ assignee: 'me', sort: 'dueDate', ...(show === 'open' ? { statusCategory: 'TODO,IN_PROGRESS' } : {}) });
  const weekEnd = addDays(today, 7);
  const groupOf = (t) => (!t.dueDate ? 'none' : t.dueDate < today && show === 'open' ? 'overdue' : t.dueDate <= weekEnd ? 'week' : 'later');
  const rows = tasks.data?.data ?? [];

  return (
    <>
      <PageHeader
        title="My tasks"
        description="Tasks assigned to you across all projects."
        actions={
          <NativeSelect aria-label="Show" className="w-auto" value={show} onChange={(e) => setFilters({ show: e.target.value })}>
            <option value="open">Open</option>
            <option value="all">All, including done</option>
          </NativeSelect>
        }
      />
      {tasks.isPending ? (
        <Skeleton className="h-64" />
      ) : tasks.error ? (
        <Card>
          <ErrorState error={tasks.error} onRetry={() => tasks.refetch()} />
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState icon={ListTodo} title="Nothing assigned to you" description="Tasks assigned to you in any project appear here." />
        </Card>
      ) : (
        <div className="grid gap-4">
          {GROUPS.map((g) => {
            const list = rows.filter((t) => groupOf(t) === g.id);
            if (!list.length) return null;
            return (
              <Card key={g.id}>
                <h2 className={`border-b px-4 py-3 text-sm font-semibold ${g.id === 'overdue' ? 'text-danger' : ''}`}>
                  {g.label} <span className="font-normal text-muted-foreground">({list.length})</span>
                </h2>
                <ul className="divide-y">
                  {list.map((t) => (
                    <li key={t.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                      <PriorityLabel priority={t.priority} compact />
                      <Link href={`/tasks/${t.id}`} className="min-w-0 flex-1 font-medium hover:underline">
                        <span className="mr-2 text-xs font-normal text-muted-foreground">{t.key}</span>
                        {t.title}
                      </Link>
                      <span className="hidden text-xs text-muted-foreground sm:inline">{t.project.name}</span>
                      <TaskStatusBadge status={t.status} />
                      <span className="w-24 text-right text-xs text-muted-foreground">{formatDate(t.dueDate)}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
