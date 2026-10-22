'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import { Archive, ChevronLeft, ChevronRight, Flag, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, NativeSelect } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { EmptyState, ErrorState } from '@/components/common/states';
import { DataTable } from '@/components/data-tables/data-table';
import { StatTile } from '@/features/dashboard/stat-tile';
import { MonthGrid } from '@/features/calendar/month-grid';
import { useEmployees } from '@/features/employees/queries';
import { useMe } from '@/features/session/session-provider';
import { QuickAddTask } from '@/features/tasks/quick-add';
import { api } from '@/lib/api';
import { addDays, formatDate, formatDuration, todayIn } from '@/lib/format';
import { cn } from '@/lib/utils';
import { PRIORITIES, PriorityLabel, ProjectStatusBadge, TaskStatusBadge } from './badges';
import { Board } from './board';
import { ProjectDialog } from './project-dialog';
import { ProgressBar } from './projects-page';
import { useInvalidateWork, useMilestones, useProject, useProjectMembers, useProjectSummary, useStatuses, useTasks } from './queries';
import { PROJECT_TABS } from './tabs';
import { CustomFieldsCard } from '@/features/custom-fields/custom-fields';


// ─── overview ───────────────────────────────────────────────────────────────

function Overview({ project }) {
  const summary = useProjectSummary(project.id);
  if (summary.isPending) return <Skeleton className="h-64" />;
  if (summary.error) return <ErrorState error={summary.error} onRetry={() => summary.refetch()} />;
  const s = summary.data;
  const done = s.tasks.total ? Math.round((s.tasks.byCategory.DONE / s.tasks.total) * 100) : 0;
  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Tasks done" value={`${done}%`} basis={`${s.tasks.byCategory.DONE} of ${s.tasks.total} tasks`} />
        <StatTile label="Overdue" value={s.tasks.overdue} basis="Open tasks past their due date" />
        <StatTile label="Hours tracked" value={formatDuration(s.hours.actualS)} basis={`${formatDuration(s.hours.billableS)} billable`} />
        <StatTile
          label="Hours vs estimate"
          value={s.hours.utilization === null ? '—' : `${s.hours.utilization}%`}
          basis={s.hours.estimatedS ? `Tracked ÷ ${formatDuration(s.hours.estimatedS)} estimate` : 'No project estimate set'}
        />
      </div>
      <CustomFieldsCard entity="PROJECT" entityId={project.id} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Workload</CardTitle>
            <CardDescription>Open tasks and tracked time per project member.</CardDescription>
          </CardHeader>
          <CardContent>
            <DataTable
              caption="Workload"
              columns={[
                { key: 'name', header: 'Member', cell: (w) => <span className="font-medium">{w.name}</span> },
                { key: 'role', header: 'Role', cell: (w) => w.role.charAt(0) + w.role.slice(1).toLowerCase(), className: 'hidden sm:table-cell' },
                { key: 'open', header: 'Open tasks', cell: (w) => <span className="tabular-nums">{w.openTasks}</span> },
                { key: 'est', header: 'Open estimate', cell: (w) => formatDuration(w.openEstimateS), className: 'hidden md:table-cell' },
                { key: 'tracked', header: 'Tracked', cell: (w) => formatDuration(w.trackedS) },
              ]}
              rows={s.workload}
              rowKey="employeeId"
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Budget</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 text-sm">
            {s.hours.estimatedS ? (
              <div>
                <p className="mb-1">
                  {formatDuration(s.hours.actualS)} of {formatDuration(s.hours.estimatedS)} hours
                </p>
                <ProgressBar value={s.hours.utilization} label="Hours used of estimate" />
              </div>
            ) : (
              <p className="text-muted-foreground">No hour estimate set.</p>
            )}
            {s.budget ? (
              <p>
                Budget{' '}
                <span className="font-semibold">
                  {new Intl.NumberFormat(undefined, { style: 'currency', currency: s.budget.currency }).format(Number(s.budget.amount))}
                </span>
                <span className="block text-xs text-muted-foreground">Cost against budget needs billing rates (Phase 9).</span>
              </p>
            ) : null}
          </CardContent>
        </Card>
      </div>
      {project.description && (
        <Card>
          <CardHeader>
            <CardTitle>About</CardTitle>
          </CardHeader>
          <CardContent className="text-sm whitespace-pre-wrap">{project.description}</CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── list ───────────────────────────────────────────────────────────────────

function TaskList({ project, today }) {
  const invalidate = useInvalidateWork();
  const statuses = useStatuses(project.id);
  const [selected, setSelected] = useState(new Set());
  const [filter, setFilter] = useState('open');
  const params = { projectId: project.id, sort: 'dueDate', ...(filter === 'open' ? { statusCategory: 'TODO,IN_PROGRESS' } : {}) };
  const tasks = useTasks(params);
  const rows = tasks.data?.data ?? [];
  const canEdit = project.access.canEditTasks;
  const bulk = useMutation({
    mutationFn: (body) => api.post('/tasks/bulk', { taskIds: [...selected], ...body }),
    onSuccess: ({ data }) => {
      toast.success(`${data.updated} tasks updated`);
      setSelected(new Set());
      invalidate();
    },
    onError: (error) => toast.error(error.message),
  });
  const toggle = (id) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const columns = [
    ...(canEdit
      ? [
          {
            key: 'select',
            header: <span className="sr-only">Select</span>,
            cell: (t) => <input type="checkbox" aria-label={`Select ${t.key}`} className="size-4 accent-[var(--primary)]" checked={selected.has(t.id)} onChange={() => toggle(t.id)} />,
          },
        ]
      : []),
    {
      key: 'title',
      header: 'Task',
      cell: (t) => (
        <Link href={`/tasks/${t.id}`} className="font-medium hover:underline">
          <span className="mr-2 text-xs font-normal text-muted-foreground">{t.key}</span>
          {t.parentId && <span className="sr-only">Subtask: </span>}
          {t.title}
        </Link>
      ),
    },
    { key: 'status', header: 'Status', cell: (t) => <TaskStatusBadge status={t.status} /> },
    { key: 'priority', header: 'Priority', cell: (t) => <PriorityLabel priority={t.priority} />, className: 'hidden md:table-cell' },
    { key: 'assignees', header: 'Assignees', cell: (t) => t.assignees.map((a) => a.name).join(', ') || '—', className: 'hidden lg:table-cell' },
    {
      key: 'due',
      header: 'Due',
      cell: (t) => (
        <span className={cn(t.dueDate && t.dueDate < today && !['DONE', 'CANCELLED'].includes(t.status.category) && 'font-medium text-danger')}>{formatDate(t.dueDate)}</span>
      ),
    },
  ];

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3 border-b p-4">
        <NativeSelect aria-label="Show" className="w-auto" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="open">Open tasks</option>
          <option value="all">All tasks</option>
        </NativeSelect>
        {project.access.canCreateTasks && (
          <div className="min-w-64 flex-1">
            <QuickAddTask projectId={project.id} />
          </div>
        )}
        {selected.size > 0 && (
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Bulk actions">
            <span className="text-sm font-medium">{selected.size} selected</span>
            <NativeSelect aria-label="Set status" className="h-8 w-auto" defaultValue="" onChange={(e) => e.target.value && bulk.mutate({ action: 'status', value: e.target.value })}>
              <option value="">Set status…</option>
              {statuses.data?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </NativeSelect>
            <NativeSelect aria-label="Set priority" className="h-8 w-auto" defaultValue="" onChange={(e) => e.target.value && bulk.mutate({ action: 'priority', value: e.target.value })}>
              <option value="">Set priority…</option>
              {PRIORITIES.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </NativeSelect>
            <Button size="sm" variant="outline" onClick={() => bulk.mutate({ action: 'archive' })}>
              <Archive aria-hidden /> Archive
            </Button>
          </div>
        )}
      </div>
      <DataTable
        caption={`${project.name} tasks`}
        columns={columns}
        rows={rows}
        isPending={tasks.isPending}
        error={tasks.error}
        onRetry={() => tasks.refetch()}
        empty={<EmptyState title={filter === 'open' ? 'No open tasks' : 'No tasks yet'} />}
      />
    </Card>
  );
}

// ─── timeline ───────────────────────────────────────────────────────────────

function Timeline({ project, today }) {
  const tasks = useTasks({ projectId: project.id, sort: 'dueDate' });
  const milestones = useMilestones(project.id);
  const dated = (tasks.data?.data ?? []).filter((t) => t.startDate || t.dueDate);
  const range = useMemo(() => {
    const dates = [...dated.flatMap((t) => [t.startDate, t.dueDate]), ...(milestones.data ?? []).map((m) => m.dueDate), today].filter(Boolean).sort();
    const from = addDays(dates[0] ?? today, -2);
    const to = addDays(dates.at(-1) ?? today, 3);
    return { from, to, days: Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1 };
  }, [dated, milestones.data, today]);
  if (tasks.isPending) return <Skeleton className="h-64" />;
  const pos = (iso) => ((Date.parse(iso) - Date.parse(range.from)) / 86_400_000 / range.days) * 100;
  const weeks = [];
  for (let d = range.from; d <= range.to; d = addDays(d, 7)) weeks.push(d);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Timeline</CardTitle>
        <CardDescription>Tasks with a start or due date, and milestones. The List view shows the same tasks as a table.</CardDescription>
      </CardHeader>
      <CardContent>
        {dated.length === 0 ? (
          <EmptyState title="No dated tasks" description="Give tasks a start or due date to see them here." />
        ) : (
          <div className="overflow-x-auto">
            <div className="min-w-[48rem]">
              <div className="relative ml-56 h-6 border-b text-xs text-muted-foreground" aria-hidden>
                {weeks.filter((w) => pos(w) < 94).map((w) => (
                  <span key={w} className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${pos(w)}%` }}>
                    {formatDate(w).replace(/,? \d{4}$/, '')}
                  </span>
                ))}
              </div>
              <ul>
                {dated.map((t) => {
                  const start = t.startDate ?? t.dueDate;
                  const end = t.dueDate ?? t.startDate;
                  const left = pos(start);
                  const width = Math.max(pos(addDays(end, 1)) - left, 1.5);
                  return (
                    <li key={t.id} className="flex h-9 items-center border-b">
                      <Link href={`/tasks/${t.id}`} className="w-56 shrink-0 truncate pr-3 text-sm hover:underline">
                        <span className="mr-1 text-xs text-muted-foreground">{t.key}</span>
                        {t.title}
                      </Link>
                      <div className="relative h-full flex-1">
                        <div className="absolute inset-y-0 border-l border-danger/60" style={{ left: `${pos(today)}%` }} aria-hidden />
                        <div
                          className={cn('absolute top-2 h-5 rounded', t.status.category === 'DONE' ? 'bg-success/60' : 'bg-primary/70')}
                          style={{ left: `${left}%`, width: `${width}%` }}
                          title={`${t.title}: ${formatDate(start)} – ${formatDate(end)} (${t.status.name})`}
                        />
                        <span className="sr-only">
                          {formatDate(start)} to {formatDate(end)}, {t.status.name}
                        </span>
                      </div>
                    </li>
                  );
                })}
                {(milestones.data ?? [])
                  .filter((m) => m.dueDate)
                  .map((m) => (
                    <li key={m.id} className="flex h-9 items-center border-b">
                      <span className="flex w-56 shrink-0 items-center gap-1 truncate pr-3 text-sm font-medium">
                        <Flag className="size-3.5 text-warning" aria-hidden /> {m.name}
                      </span>
                      <div className="relative h-full flex-1">
                        <span className="absolute top-2 size-4 -translate-x-1/2 rotate-45 bg-warning" style={{ left: `${pos(m.dueDate)}%` }} title={`${m.name}: ${formatDate(m.dueDate)}`} aria-hidden />
                        <span className="sr-only">Milestone due {formatDate(m.dueDate)}</span>
                      </div>
                    </li>
                  ))}
              </ul>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── calendar ───────────────────────────────────────────────────────────────

function ProjectCalendar({ project, today }) {
  const [month, setMonth] = useState(today.slice(0, 7));
  const tasks = useTasks({ projectId: project.id });
  const milestones = useMilestones(project.id);
  const items = [
    ...(tasks.data?.data ?? [])
      .filter((t) => t.dueDate)
      .map((t) => ({ id: t.id, start: t.dueDate, title: `${t.key} ${t.title}`, source: 'tasks', link: `/tasks/${t.id}`, done: t.status.category === 'DONE' })),
    ...(milestones.data ?? []).filter((m) => m.dueDate).map((m) => ({ id: m.id, start: m.dueDate, title: m.name, source: 'milestones', done: Boolean(m.completedAt) })),
  ];
  const shift = (delta) => {
    const d = new Date(`${month}-01T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + delta);
    setMonth(d.toISOString().slice(0, 7));
  };
  return (
    <Card>
      <CardHeader className="flex-row items-center gap-2">
        <Button variant="outline" size="icon" aria-label="Previous month" onClick={() => shift(-1)}>
          <ChevronLeft aria-hidden />
        </Button>
        <CardTitle className="min-w-40 text-center">
          {new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-01T00:00:00Z`))}
        </CardTitle>
        <Button variant="outline" size="icon" aria-label="Next month" onClick={() => shift(1)}>
          <ChevronRight aria-hidden />
        </Button>
      </CardHeader>
      <CardContent>
        <MonthGrid month={month} items={items} today={today} />
      </CardContent>
    </Card>
  );
}

// ─── milestones ─────────────────────────────────────────────────────────────

function Milestones({ project }) {
  const invalidate = useInvalidateWork();
  const milestones = useMilestones(project.id);
  const [name, setName] = useState('');
  const [dueDate, setDueDate] = useState('');
  const canManage = project.access.canManage;
  const save = useMutation({
    mutationFn: ({ id, body }) => (id ? api.patch(`/projects/${project.id}/milestones/${id}`, body) : api.post(`/projects/${project.id}/milestones`, body)),
    onSuccess: () => {
      setName('');
      setDueDate('');
      invalidate();
    },
    onError: (error) => toast.error(error.message),
  });
  const remove = useMutation({ mutationFn: (id) => api.delete(`/projects/${project.id}/milestones/${id}`), onSuccess: invalidate, onError: (e) => toast.error(e.message) });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Milestones</CardTitle>
      </CardHeader>
      <CardContent>
        {canManage && (
          <form
            className="mb-4 grid gap-2 sm:grid-cols-[1fr_10rem_auto]"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) save.mutate({ body: { name: name.trim(), dueDate: dueDate || null } });
            }}
          >
            <Input aria-label="Milestone name" placeholder="Milestone name" value={name} onChange={(e) => setName(e.target.value)} maxLength={160} />
            <Input aria-label="Due date" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            <Button type="submit" variant="outline" disabled={!name.trim()}>
              <Plus aria-hidden /> Add
            </Button>
          </form>
        )}
        {milestones.isPending ? (
          <Skeleton className="h-16" />
        ) : milestones.data?.length ? (
          <ul className="divide-y">
            {milestones.data.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
                <Flag className={cn('size-4', m.completedAt ? 'text-success' : 'text-warning')} aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className={cn('font-medium', m.completedAt && 'line-through')}>{m.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {m.dueDate ? `Due ${formatDate(m.dueDate)}` : 'No date'} · {m.doneCount}/{m.taskCount} tasks done
                  </p>
                </div>
                {canManage && (
                  <>
                    <label className="flex items-center gap-2 text-xs">
                      <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={Boolean(m.completedAt)} onChange={(e) => save.mutate({ id: m.id, body: { completed: e.target.checked } })} />
                      Reached
                    </label>
                    <Button variant="ghost" size="icon" aria-label={`Delete ${m.name}`} onClick={() => remove.mutate(m.id)}>
                      <Trash2 aria-hidden />
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No milestones yet.</p>
        )}
      </CardContent>
    </Card>
  );
}

// ─── members ────────────────────────────────────────────────────────────────

function MembersDialog({ project, members, onClose }) {
  const invalidate = useInvalidateWork();
  const people = useEmployees({ status: 'ACTIVE', limit: 100, sort: 'name' });
  const [roles, setRoles] = useState(() => Object.fromEntries(members.map((m) => [m.employeeId, m.role])));
  const save = useMutation({
    mutationFn: () => api.put(`/projects/${project.id}/members`, { members: Object.entries(roles).filter(([, r]) => r).map(([employeeId, role]) => ({ employeeId, role })) }),
    onSuccess: () => {
      toast.success('Members updated');
      invalidate();
      onClose();
    },
    onError: (error) => toast.error(error.message),
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Project members</DialogTitle>
          <DialogDescription>Managers edit the project; members work on tasks; viewers can only read.</DialogDescription>
        </DialogHeader>
        <ul className="max-h-80 divide-y overflow-y-auto rounded-md border">
          {people.data?.data.map((p) => (
            <li key={p.employeeId} className="flex items-center gap-3 px-3 py-2 text-sm">
              <span className="flex-1">{p.name}</span>
              <NativeSelect aria-label={`Role for ${p.name}`} className="h-8 w-36" value={roles[p.employeeId] ?? ''} onChange={(e) => setRoles({ ...roles, [p.employeeId]: e.target.value })}>
                <option value="">Not a member</option>
                <option value="MANAGER">Manager</option>
                <option value="MEMBER">Member</option>
                <option value="VIEWER">Viewer</option>
              </NativeSelect>
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            Save members
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Members({ project }) {
  const members = useProjectMembers(project.id);
  const [editing, setEditing] = useState(false);
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Members</CardTitle>
        {project.access.canManage && (
          <Button size="sm" variant="outline" onClick={() => setEditing(true)} disabled={!members.data}>
            Manage members
          </Button>
        )}
      </CardHeader>
      <CardContent>
        <DataTable
          caption="Project members"
          columns={[
            { key: 'name', header: 'Name', cell: (m) => <Link href={`/employees/${m.employeeId}`} className="font-medium hover:underline">{m.name}</Link> },
            { key: 'role', header: 'Project role', cell: (m) => <Badge tone={m.role === 'MANAGER' ? 'info' : 'neutral'}>{m.role.charAt(0) + m.role.slice(1).toLowerCase()}</Badge> },
          ]}
          rows={members.data ?? []}
          rowKey="employeeId"
          isPending={members.isPending}
          error={members.error}
        />
      </CardContent>
      {editing && <MembersDialog project={project} members={members.data} onClose={() => setEditing(false)} />}
    </Card>
  );
}

// ─── settings ───────────────────────────────────────────────────────────────

function Settings({ project }) {
  const router = useRouter();
  const invalidate = useInvalidateWork();
  const statuses = useStatuses(project.id);
  const [newStatus, setNewStatus] = useState({ name: '', category: 'TODO' });
  const [deleting, setDeleting] = useState(null);
  const [moveTo, setMoveTo] = useState('');
  const [confirmArchive, setConfirmArchive] = useState(false);
  const run = (fn, success) => async () => {
    try {
      await fn();
      if (success) toast.success(success);
      await invalidate();
    } catch (error) {
      toast.error(error.details?.[0]?.message ?? error.message);
    }
  };
  if (!project.access.canManage) return <EmptyState title="Only project managers can change settings" />;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Workflow</CardTitle>
          <CardDescription>Board columns. The category decides what counts as started or done.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="mb-4 divide-y">
            {statuses.data?.map((s) => (
              <li key={s.id} className="flex items-center gap-2 py-2 text-sm">
                <span className="flex-1">{s.name}</span>
                <TaskStatusBadge status={{ name: s.category.replace('_', ' ').toLowerCase(), category: s.category }} />
                <Button variant="ghost" size="icon" aria-label={`Delete ${s.name}`} onClick={() => setDeleting(s)}>
                  <Trash2 aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
          <form
            className="grid gap-2 sm:grid-cols-[1fr_9rem_auto]"
            onSubmit={(e) => {
              e.preventDefault();
              run(() => api.post(`/projects/${project.id}/statuses`, newStatus), 'Status added')().then(() => setNewStatus({ name: '', category: 'TODO' }));
            }}
          >
            <Input aria-label="New status name" placeholder="New status" value={newStatus.name} onChange={(e) => setNewStatus({ ...newStatus, name: e.target.value })} maxLength={60} required />
            <NativeSelect aria-label="Category" value={newStatus.category} onChange={(e) => setNewStatus({ ...newStatus, category: e.target.value })}>
              <option value="TODO">To do</option>
              <option value="IN_PROGRESS">In progress</option>
              <option value="DONE">Done</option>
              <option value="CANCELLED">Cancelled</option>
            </NativeSelect>
            <Button type="submit" variant="outline">
              Add
            </Button>
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Lifecycle</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {project.status !== 'COMPLETED' && (
            <Button variant="outline" onClick={run(() => api.post(`/projects/${project.id}/close`), 'Project marked completed')}>
              Mark completed
            </Button>
          )}
          {project.archivedAt ? (
            <Button onClick={run(() => api.post(`/projects/${project.id}/restore`), 'Project restored')}>Restore</Button>
          ) : (
            <Button variant="destructive" onClick={() => setConfirmArchive(true)}>
              <Archive aria-hidden /> Archive project
            </Button>
          )}
        </CardContent>
      </Card>
      <Dialog open={Boolean(deleting)} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete “{deleting?.name}”?</DialogTitle>
            <DialogDescription>Tasks in this status move to the status you choose.</DialogDescription>
          </DialogHeader>
          <NativeSelect aria-label="Move tasks to" value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
            <option value="">Move tasks to…</option>
            {statuses.data?.filter((s) => s.id !== deleting?.id).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </NativeSelect>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={run(async () => {
                await api.delete(`/projects/${project.id}/statuses/${deleting.id}`, moveTo ? { body: { moveToStatusId: moveTo } } : undefined);
                setDeleting(null);
              }, 'Status deleted')}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={confirmArchive} onOpenChange={setConfirmArchive}>
        <AlertDialogContent>
          <AlertDialogTitle>Archive {project.name}?</AlertDialogTitle>
          <AlertDialogDescription>It disappears from lists and no new tasks or time can be added. Its history is kept and it can be restored.</AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction destructive onClick={run(async () => (await api.delete(`/projects/${project.id}`), router.push('/projects')), 'Project archived')}>
              Archive
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ─── page ───────────────────────────────────────────────────────────────────

const TABS = { overview: Overview, board: Board, list: TaskList, timeline: Timeline, calendar: ProjectCalendar, milestones: Milestones, members: Members, settings: Settings };

export function ProjectDetail({ projectId, tab }) {
  const me = useMe();
  const today = todayIn(me.organization.timeZone);
  const project = useProject(projectId);
  const [editing, setEditing] = useState(false);
  if (project.isPending) return <Skeleton className="h-96" />;
  if (project.error) {
    return project.error.status === 404 ? <EmptyState title="Project not found" description="It may be private or archived." /> : <ErrorState error={project.error} onRetry={() => project.refetch()} />;
  }
  const p = project.data;
  const Tab = TABS[tab];
  return (
    <>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-medium text-muted-foreground">
            <Link href="/projects" className="hover:underline">
              Projects
            </Link>{' '}
            / {p.code}
          </p>
          <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold">
            {p.name} <ProjectStatusBadge status={p.status} />
            {p.archivedAt && <Badge tone="neutral">Archived</Badge>}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {p.manager ? `Managed by ${p.manager.name}` : 'No manager'}
            {p.deadline ? ` · deadline ${formatDate(p.deadline)}` : ''} · {p.visibility === 'ORG' ? 'Visible to everyone' : 'Members only'}
          </p>
        </div>
        {p.access.canManage && (
          <Button variant="outline" onClick={() => setEditing(true)}>
            <Pencil aria-hidden /> Edit project
          </Button>
        )}
      </div>
      <nav aria-label="Project views" className="mb-4 overflow-x-auto border-b">
        <ul className="flex min-w-max gap-1">
          {PROJECT_TABS.map((t) => (
            <li key={t.id}>
              <Link
                href={`/projects/${p.id}/${t.id}`}
                aria-current={t.id === tab ? 'page' : undefined}
                className={cn('inline-flex h-10 items-center border-b-2 px-3 text-sm', t.id === tab ? 'border-primary font-medium text-primary' : 'border-transparent text-muted-foreground hover:text-foreground')}
              >
                {t.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <Tab project={p} today={today} />
      {editing && <ProjectDialog project={p} onClose={() => setEditing(false)} />}
    </>
  );
}
