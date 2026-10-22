'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { CalendarDays, MessageSquare } from 'lucide-react';
import { toast } from 'sonner';
import { Avatar } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/common/states';
import { QuickAddTask } from '@/features/tasks/quick-add';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { PriorityLabel } from './badges';
import { projectKeys, useInvalidateWork, useStatuses, useTasks } from './queries';

const SORT_STEP = 1024;

function TaskCard({ task, statuses, canEdit, onMove, today }) {
  const overdue = task.dueDate && task.dueDate < today && !['DONE', 'CANCELLED'].includes(task.status.category);
  return (
    <article
      draggable={canEdit}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', task.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      className={cn('rounded-md border bg-card p-3 shadow-xs', canEdit && 'cursor-grab active:cursor-grabbing')}
      aria-label={`${task.key} ${task.title}`}
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{task.key}</span>
        <PriorityLabel priority={task.priority} compact />
      </div>
      <Link href={`/tasks/${task.id}`} className="mb-2 block text-sm font-medium hover:underline">
        {task.title}
      </Link>
      {task.labels.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {task.labels.map((l) => (
            <span key={l.id} className="rounded-sm border px-1.5 text-[11px]" style={{ borderColor: l.color, color: 'var(--foreground)' }}>
              {l.name}
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {task.dueDate && (
          <span className={cn('inline-flex items-center gap-1', overdue && 'font-medium text-danger')}>
            <CalendarDays className="size-3.5" aria-hidden />
            {formatDate(task.dueDate)}
            {overdue && <span className="sr-only"> (overdue)</span>}
          </span>
        )}
        {task.counts.comments > 0 && (
          <span className="inline-flex items-center gap-1">
            <MessageSquare className="size-3.5" aria-hidden />
            {task.counts.comments}
            <span className="sr-only">comments</span>
          </span>
        )}
        <span className="ml-auto flex -space-x-1.5">
          {task.assignees.slice(0, 3).map((a) => (
            <span key={a.employeeId} title={a.name}>
              <Avatar name={a.name} size="sm" className="size-6 border-2 border-card text-[10px]" />
            </span>
          ))}
          <span className="sr-only">Assigned to {task.assignees.map((a) => a.name).join(', ') || 'no one'}</span>
        </span>
      </div>
      {canEdit && (
        <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
          Move to
          <select className="h-7 flex-1 rounded border bg-card px-1 text-xs" value={task.status.id} onChange={(e) => onMove(task, e.target.value, null)}>
            {statuses.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      )}
    </article>
  );
}

/** Kanban by workflow status. Drag and drop with the mouse, or use each card's "Move to". */
export function Board({ project, today }) {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateWork();
  const statuses = useStatuses(project.id);
  const params = { projectId: project.id };
  const tasks = useTasks(params);
  const [dragOver, setDragOver] = useState(null);
  const canEdit = project.access.canEditTasks;

  async function move(task, statusId, beforeTaskId) {
    const column = (tasks.data?.data ?? []).filter((t) => t.status.id === statusId && t.id !== task.id).sort((a, b) => a.sort - b.sort);
    let sort;
    const index = beforeTaskId ? column.findIndex((t) => t.id === beforeTaskId) : -1;
    if (index === -1) sort = (column.at(-1)?.sort ?? 0) + SORT_STEP;
    else sort = ((column[index - 1]?.sort ?? column[index].sort - SORT_STEP) + column[index].sort) / 2;
    const status = statuses.data.find((s) => s.id === statusId);
    // Optimistic: move the card now; the server response (or an error) reconciles.
    queryClient.setQueryData(projectKeys.tasks(params), (old) =>
      old ? { ...old, data: old.data.map((t) => (t.id === task.id ? { ...t, sort, status: { id: status.id, name: status.name, category: status.category } } : t)) } : old,
    );
    try {
      await api.patch(`/tasks/${task.id}`, { statusId, sort });
    } catch (error) {
      toast.error(error.message);
    } finally {
      invalidate();
    }
  }

  if (statuses.isPending || tasks.isPending) return <Skeleton className="h-96" />;
  if (statuses.error || tasks.error) return <ErrorState error={statuses.error ?? tasks.error} onRetry={() => tasks.refetch()} />;
  const all = tasks.data.data;

  return (
    <div className="flex gap-4 overflow-x-auto pb-4">
      {statuses.data.map((status) => {
        const column = all.filter((t) => t.status.id === status.id).sort((a, b) => a.sort - b.sort);
        return (
          <section
            key={status.id}
            aria-label={`${status.name}, ${column.length} tasks`}
            className={cn('flex w-64 shrink-0 flex-col rounded-lg bg-muted/70 p-3', dragOver === status.id && 'ring-2 ring-primary')}
            onDragOver={(e) => {
              if (!canEdit) return;
              e.preventDefault();
              setDragOver(status.id);
            }}
            onDragLeave={() => setDragOver(null)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(null);
              const task = all.find((t) => t.id === e.dataTransfer.getData('text/plain'));
              const beforeId = e.target.closest?.('[data-task-id]')?.dataset.taskId;
              if (task) move(task, status.id, beforeId && beforeId !== task.id ? beforeId : null);
            }}
          >
            <h3 className="mb-3 flex items-center justify-between text-sm font-semibold">
              {status.name}
              <span className="rounded-full bg-card px-2 text-xs font-medium text-muted-foreground">{column.length}</span>
            </h3>
            <ul className="mb-3 grid gap-2">
              {column.map((task) => (
                <li key={task.id} data-task-id={task.id}>
                  <TaskCard task={task} statuses={statuses.data} canEdit={canEdit} onMove={move} today={today} />
                </li>
              ))}
            </ul>
            {project.access.canCreateTasks && <QuickAddTask projectId={project.id} statusId={status.id} label={`Add task to ${status.name}`} />}
          </section>
        );
      })}
    </div>
  );
}
