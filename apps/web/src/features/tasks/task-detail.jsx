'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Archive, Download, Link2, Paperclip, Play, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, NativeSelect, Textarea } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Avatar } from '@/components/ui/avatar';
import { EmptyState, ErrorState } from '@/components/common/states';
import { PRIORITIES, TaskStatusBadge } from '@/features/projects/badges';
import { projectKeys, useInvalidateWork, useLabels, useProjectMembers, useStatuses, useTask, useTasks } from '@/features/projects/queries';
import { useWorkActions } from '@/features/time/use-work-state';
import { useCan } from '@/features/session/session-provider';
import { api } from '@/lib/api';
import { formatDate, formatDuration, formatRelative } from '@/lib/format';
import { CustomFieldsCard } from '@/features/custom-fields/custom-fields';

const HISTORY_LABEL = {
  created: 'created the task',
  updated: 'updated details',
  status_changed: 'changed the status',
  assigned: 'changed assignees',
  commented: 'commented',
  archived: 'archived the task',
  restored: 'restored the task',
  recurred: 'completed this occurrence',
  dependency_added: 'added a dependency',
  attachment_added: 'attached a file',
  attachment_removed: 'removed a file',
};

function Field({ label, children }) {
  return (
    <div className="grid gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

export function TaskDetail({ taskId }) {
  const queryClient = useQueryClient();
  const invalidate = useInvalidateWork();
  const canTrack = useCan('time.self');
  const canCreate = useCan('tasks.create');
  const { run: runWork } = useWorkActions();
  const task = useTask(taskId);
  const projectId = task.data?.project.id;
  const statuses = useStatuses(projectId);
  const members = useProjectMembers(projectId);
  const labels = useLabels();
  const projectTasks = useTasks({ projectId }, { enabled: Boolean(projectId) });
  const [comment, setComment] = useState('');
  const [checkItem, setCheckItem] = useState('');
  const [uploading, setUploading] = useState(false);

  const mutate = useMutation({
    mutationFn: ({ method = 'patch', path = '', body }) => api[method](`/tasks/${taskId}${path}`, body),
    onSuccess: (res) => {
      if (res?.data?.id === taskId) queryClient.setQueryData(projectKeys.task(taskId), res.data);
      invalidate();
    },
    onError: (error) => toast.error(error.details?.[0]?.message && error.code !== 'TASK_BLOCKED' ? error.details[0].message : error.message),
  });
  const patch = (body) => mutate.mutate({ body: { ...body } });

  if (task.isPending) return <Skeleton className="h-96" />;
  if (task.error) return task.error.status === 404 ? <EmptyState title="Task not found" description="It may be in a project you cannot see." /> : <ErrorState error={task.error} onRetry={() => task.refetch()} />;
  const t = task.data;
  const canEdit = t.access.canEdit && !t.archivedAt;

  async function upload(file) {
    setUploading(true);
    try {
      const { data } = await api.post(`/tasks/${taskId}/attachments/presign`, { fileName: file.name, contentType: file.type || 'application/octet-stream', sizeBytes: file.size });
      const res = await fetch(data.upload.url, { method: 'PUT', headers: data.upload.headers, body: file });
      if (!res.ok) throw new Error(`Upload failed (${res.status})`);
      await api.post(`/tasks/${taskId}/attachments/${data.fileId}/complete`);
      toast.success(`${file.name} attached`);
      task.refetch();
    } catch (error) {
      toast.error(error.details?.[0]?.message ?? error.message);
    } finally {
      setUploading(false);
    }
  }

  async function download(fileId) {
    try {
      const { data } = await api.get(`/tasks/${taskId}/attachments/${fileId}/access-url`);
      window.location.assign(data.url);
    } catch (error) {
      toast.error(error.message);
    }
  }

  return (
    <>
      <p className="mb-1 text-xs font-medium text-muted-foreground">
        <Link href={`/projects/${t.project.id}/board`} className="hover:underline">
          {t.project.name}
        </Link>{' '}
        / {t.key}
        {t.parent && (
          <>
            {' '}
            · subtask of{' '}
            <Link href={`/tasks/${t.parent.id}`} className="hover:underline">
              {t.parent.key}
            </Link>
          </>
        )}
      </p>
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        {canEdit ? (
          <Input
            aria-label="Title"
            defaultValue={t.title}
            key={t.version}
            className="h-auto border-transparent px-0 text-xl font-semibold shadow-none hover:border-input focus:border-input"
            onBlur={(e) => e.target.value.trim() && e.target.value !== t.title && patch({ title: e.target.value.trim() })}
          />
        ) : (
          <h1 className="text-xl font-semibold">{t.title}</h1>
        )}
        <div className="flex shrink-0 gap-2">
          {canTrack && !t.archivedAt && (
            <Button variant="outline" onClick={() => runWork('startTimer', { taskId, description: t.title, isBillable: true })}>
              <Play aria-hidden /> Track time
            </Button>
          )}
          {canEdit && (
            <Button variant="outline" onClick={() => mutate.mutate({ method: 'delete', path: '' })}>
              <Archive aria-hidden /> Archive
            </Button>
          )}
          {t.archivedAt && t.access.canEdit && <Button onClick={() => mutate.mutate({ method: 'post', path: '/restore' })}>Restore</Button>}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="grid content-start gap-4 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Description</CardTitle>
            </CardHeader>
            <CardContent>
              {canEdit ? (
                <Textarea
                  aria-label="Description"
                  defaultValue={t.description ?? ''}
                  key={`d${t.version}`}
                  className="min-h-32"
                  placeholder="Add details, acceptance criteria, links…"
                  onBlur={(e) => e.target.value !== (t.description ?? '') && patch({ description: e.target.value || null })}
                />
              ) : (
                <p className="text-sm whitespace-pre-wrap">{t.description || <span className="text-muted-foreground">No description.</span>}</p>
              )}
            </CardContent>
          </Card>

          <CustomFieldsCard entity="TASK" entityId={t.id} />

          <Card>
            <CardHeader>
              <CardTitle>
                Checklist ({t.checklist.filter((c) => c.done).length}/{t.checklist.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="mb-3 grid gap-1">
                {t.checklist.map((c) => (
                  <li key={c.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      aria-label={c.text}
                      className="size-4 accent-[var(--primary)]"
                      checked={c.done}
                      disabled={!canEdit}
                      onChange={(e) => mutate.mutate({ path: `/checklist/${c.id}`, body: { done: e.target.checked } })}
                    />
                    <span className={c.done ? 'flex-1 text-muted-foreground line-through' : 'flex-1'}>{c.text}</span>
                    {canEdit && (
                      <Button variant="ghost" size="icon" aria-label={`Remove ${c.text}`} onClick={() => mutate.mutate({ method: 'delete', path: `/checklist/${c.id}` })}>
                        <X aria-hidden />
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
              {canEdit && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (checkItem.trim()) mutate.mutate({ method: 'post', path: '/checklist', body: { text: checkItem.trim() } }, { onSuccess: () => setCheckItem('') });
                  }}
                >
                  <Input aria-label="New checklist item" placeholder="Add an item" value={checkItem} onChange={(e) => setCheckItem(e.target.value)} maxLength={300} />
                </form>
              )}
            </CardContent>
          </Card>

          {(t.subtasks.length > 0 || !t.parent) && (
            <Card>
              <CardHeader>
                <CardTitle>Subtasks</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="mb-3 divide-y">
                  {t.subtasks.map((s) => (
                    <li key={s.id} className="flex items-center gap-2 py-2 text-sm">
                      <Link href={`/tasks/${s.id}`} className="flex-1 hover:underline">
                        <span className="mr-2 text-xs text-muted-foreground">{s.key}</span>
                        {s.title}
                      </Link>
                      <TaskStatusBadge status={s.status} />
                    </li>
                  ))}
                </ul>
                {canEdit && canCreate && !t.parent && <SubtaskAdd projectId={t.project.id} parentId={taskId} onDone={() => task.refetch()} />}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle>Attachments</CardTitle>
              {canEdit && (
                <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-sm hover:bg-muted">
                  <Paperclip className="size-4" aria-hidden />
                  {uploading ? 'Uploading…' : 'Attach file'}
                  <input type="file" className="sr-only" disabled={uploading} onChange={(e) => e.target.files[0] && upload(e.target.files[0])} />
                </label>
              )}
            </CardHeader>
            <CardContent>
              {t.attachments.length ? (
                <ul className="divide-y">
                  {t.attachments.map((f) => (
                    <li key={f.id} className="flex items-center gap-2 py-2 text-sm">
                      <span className="min-w-0 flex-1 truncate">{f.name}</span>
                      <span className="text-xs text-muted-foreground">{Math.ceil(f.sizeBytes / 1024)} KB</span>
                      <Button variant="ghost" size="icon" aria-label={`Download ${f.name}`} onClick={() => download(f.id)}>
                        <Download aria-hidden />
                      </Button>
                      {canEdit && (
                        <Button variant="ghost" size="icon" aria-label={`Remove ${f.name}`} onClick={() => mutate.mutate({ method: 'delete', path: `/attachments/${f.id}` })}>
                          <Trash2 aria-hidden />
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">No files. Up to 25 MB each; documents, images and archives.</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Comments</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="mb-4 grid gap-4">
                {t.comments.map((c) => (
                  <li key={c.id} className="flex gap-3">
                    <Avatar name={c.author?.name} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm">
                        <span className="font-medium">{c.author?.name}</span>{' '}
                        <span className="text-xs text-muted-foreground">
                          {formatRelative(c.createdAt)}
                          {c.editedAt && ' · edited'}
                        </span>
                      </p>
                      <p className="mt-1 text-sm whitespace-pre-wrap">{c.body}</p>
                      {c.mine && (
                        <button type="button" className="mt-1 text-xs text-muted-foreground hover:text-danger" onClick={() => mutate.mutate({ method: 'delete', path: `/comments/${c.id}` })}>
                          Delete
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
              {t.access.canComment && (
                <form
                  className="grid gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (comment.trim()) mutate.mutate({ method: 'post', path: '/comments', body: { body: comment.trim() } }, { onSuccess: () => setComment('') });
                  }}
                >
                  <Textarea aria-label="Write a comment" placeholder="Write a comment. Assignees are notified." value={comment} onChange={(e) => setComment(e.target.value)} maxLength={10000} />
                  <Button type="submit" className="justify-self-end" disabled={!comment.trim() || mutate.isPending}>
                    Comment
                  </Button>
                </form>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="grid content-start gap-4">
          <Card>
            <CardContent className="grid gap-4 pt-5">
              <Field label="Status">
                <NativeSelect aria-label="Status" value={t.status.id} disabled={!canEdit} onChange={(e) => patch({ statusId: e.target.value })}>
                  {statuses.data?.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field label="Priority">
                <NativeSelect aria-label="Priority" value={t.priority} disabled={!canEdit} onChange={(e) => patch({ priority: e.target.value })}>
                  {PRIORITIES.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Start">
                  <Input type="date" aria-label="Start date" defaultValue={t.startDate ?? ''} key={`s${t.version}`} disabled={!canEdit} onBlur={(e) => (e.target.value || null) !== t.startDate && patch({ startDate: e.target.value || null })} />
                </Field>
                <Field label="Due">
                  <Input type="date" aria-label="Due date" defaultValue={t.dueDate ?? ''} key={`u${t.version}`} disabled={!canEdit} onBlur={(e) => (e.target.value || null) !== t.dueDate && patch({ dueDate: e.target.value || null })} />
                </Field>
              </div>
              <Field label="Estimate (hours)">
                <Input
                  type="number"
                  min={0}
                  step="0.25"
                  aria-label="Estimate in hours"
                  defaultValue={t.estimatedS ? t.estimatedS / 3600 : ''}
                  key={`e${t.version}`}
                  disabled={!canEdit}
                  onBlur={(e) => {
                    const v = e.target.value === '' ? null : Math.round(Number(e.target.value) * 3600);
                    if (v !== t.estimatedS) patch({ estimatedS: v });
                  }}
                />
              </Field>
              <p className="text-sm">
                Tracked <span className="font-semibold">{formatDuration(t.trackedS)}</span>
                {t.estimatedS ? ` of ${formatDuration(t.estimatedS)}` : ''}
              </p>
              <Field label="Assignees">
                <ul className="grid gap-1">
                  {members.data
                    ?.filter((m) => m.role !== 'VIEWER')
                    .map((m) => {
                      const on = t.assignees.some((a) => a.employeeId === m.employeeId);
                      return (
                        <li key={m.employeeId}>
                          <label className="flex items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              className="size-4 accent-[var(--primary)]"
                              checked={on}
                              disabled={!canEdit}
                              onChange={() => {
                                const ids = t.assignees.map((a) => a.employeeId);
                                mutate.mutate({ method: 'put', path: '/assignees', body: { employeeIds: on ? ids.filter((id) => id !== m.employeeId) : [...ids, m.employeeId] } });
                              }}
                            />
                            {m.name}
                          </label>
                        </li>
                      );
                    })}
                </ul>
              </Field>
              <Field label="Labels">
                <div className="flex flex-wrap gap-1">
                  {labels.data?.map((l) => {
                    const on = t.labels.some((x) => x.id === l.id);
                    return (
                      <button
                        key={l.id}
                        type="button"
                        aria-pressed={on}
                        disabled={!canEdit}
                        onClick={() => mutate.mutate({ method: 'put', path: '/labels', body: { labelIds: on ? t.labels.filter((x) => x.id !== l.id).map((x) => x.id) : [...t.labels.map((x) => x.id), l.id] } })}
                        className="rounded-sm border px-2 py-0.5 text-xs aria-pressed:bg-muted aria-pressed:font-medium disabled:opacity-60"
                        style={{ borderColor: l.color }}
                      >
                        {l.name}
                      </button>
                    );
                  })}
                  {labels.data?.length === 0 && <span className="text-xs text-muted-foreground">No labels yet.</span>}
                </div>
              </Field>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Dependencies</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 text-sm">
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground">Waits for</p>
                <ul className="grid gap-1">
                  {t.dependsOn.map((d) => (
                    <li key={d.id} className="flex items-center gap-2">
                      <Link2 className="size-3.5 text-muted-foreground" aria-hidden />
                      <Link href={`/tasks/${d.id}`} className="flex-1 truncate hover:underline">
                        {d.key} {d.title}
                      </Link>
                      <TaskStatusBadge status={d.status} />
                      {canEdit && (
                        <Button variant="ghost" size="icon" aria-label={`Remove dependency on ${d.key}`} onClick={() => mutate.mutate({ method: 'delete', path: `/dependencies/${d.id}` })}>
                          <X aria-hidden />
                        </Button>
                      )}
                    </li>
                  ))}
                  {t.dependsOn.length === 0 && <li className="text-muted-foreground">Nothing</li>}
                </ul>
              </div>
              {canEdit && (
                <NativeSelect
                  aria-label="Add a task this one waits for"
                  value=""
                  onChange={(e) => e.target.value && mutate.mutate({ method: 'post', path: '/dependencies', body: { dependsOnTaskId: e.target.value } })}
                >
                  <option value="">Add “waits for”…</option>
                  {projectTasks.data?.data
                    .filter((x) => x.id !== taskId && !t.dependsOn.some((d) => d.id === x.id))
                    .map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.key} {x.title}
                      </option>
                    ))}
                </NativeSelect>
              )}
              {t.blocks.length > 0 && (
                <div>
                  <p className="mb-1 text-xs font-medium text-muted-foreground">Blocks</p>
                  <ul className="grid gap-1">
                    {t.blocks.map((b) => (
                      <li key={b.id}>
                        <Link href={`/tasks/${b.id}`} className="hover:underline">
                          {b.key} {b.title}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Activity</CardTitle>
            </CardHeader>
            <CardContent>
              {t.history.length === 0 && <p className="text-sm text-muted-foreground">No recorded changes yet.</p>}
              <ol className="grid gap-2 text-sm">
                {t.history.map((h, i) => (
                  <li key={i}>
                    <span className="font-medium">{h.actor?.name ?? 'System'}</span> {HISTORY_LABEL[h.type] ?? h.type}
                    {h.type === 'status_changed' && h.data?.status ? ` to ${h.data.status.to}` : ''}
                    <span className="block text-xs text-muted-foreground">{formatDate(h.createdAt, { withTime: true })}</span>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}

function SubtaskAdd({ projectId, parentId, onDone }) {
  const [title, setTitle] = useState('');
  const invalidate = useInvalidateWork();
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (!title.trim()) return;
        try {
          await api.post('/tasks', { projectId, parentId, title: title.trim() }, { idempotencyKey: crypto.randomUUID() });
          setTitle('');
          invalidate();
          onDone();
        } catch (error) {
          toast.error(error.message);
        }
      }}
    >
      <Input aria-label="New subtask" placeholder="Add a subtask" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} />
    </form>
  );
}
