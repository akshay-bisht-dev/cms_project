'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { LifeBuoy, Lock, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, NativeSelect, Textarea } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FormField } from '@/components/common/form-field';
import { PageHeader } from '@/components/common/page-header';
import { EmptyState, ErrorState } from '@/components/common/states';
import { DataTable } from '@/components/data-tables/data-table';
import { useEmployees, useTeams } from '@/features/employees/queries';
import { useCan } from '@/features/session/session-provider';
import { api } from '@/lib/api';
import { formatDate, formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';
import { PRIORITY, TICKET_STATUS } from '@/features/crm/labels';
import { StatusBadge } from '@/features/crm/status-badge';
import { newKey, useAction, useClients } from '@/features/crm/queries';
import { CustomFieldsCard } from '@/features/custom-fields/custom-fields';

const ticketKeys = { list: (p) => ['tickets', p], one: (id) => ['tickets', 'one', id], all: ['tickets'] };

/** SLA state of a ticket in words, with an icon-free badge (status colour + text). */
export function SlaBadge({ sla, status }) {
  if (!sla.resolutionDueAt) return <span className="text-xs text-muted-foreground">No SLA</span>;
  if (['RESOLVED', 'CLOSED'].includes(status)) return <Badge tone={sla.breached ? 'danger' : 'success'}>{sla.breached ? 'Resolved late' : 'Within SLA'}</Badge>;
  if (sla.breached) return <Badge tone="danger">SLA missed</Badge>;
  return <Badge tone="neutral">Due {formatRelative(sla.resolutionDueAt)}</Badge>;
}

function NewTicketDialog({ onClose }) {
  const router = useRouter();
  const clients = useClients({}, useCan('clients.read'));
  const people = useEmployees({ status: 'ACTIVE', limit: 100, sort: 'name' });
  const form = useForm({ defaultValues: { subject: '', description: '', priority: 'NORMAL', clientId: '', assigneeId: '' } });
  const create = useAction((v) => api.post('/support-tickets', Object.fromEntries(Object.entries(v).filter(([, x]) => x !== '')), { idempotencyKey: newKey() }), {
    success: 'Ticket opened',
    keys: [ticketKeys.all],
    onSuccess: ({ data }) => router.push(`/tickets/${data.id}`),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader><DialogTitle>New ticket</DialogTitle><DialogDescription>Deadlines come from the SLA policy for the priority.</DialogDescription></DialogHeader>
        <form onSubmit={form.handleSubmit((v) => create.mutate(v))} className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2"><FormField label="Subject" required>{(a) => <Input required maxLength={200} {...a} {...form.register('subject')} />}</FormField></div>
          <div className="sm:col-span-2"><FormField label="Description" required>{(a) => <Textarea rows={4} required {...a} {...form.register('description')} />}</FormField></div>
          <FormField label="Priority">{(a) => <NativeSelect {...a} {...form.register('priority')}>{Object.entries(PRIORITY).map(([v, [l]]) => <option key={v} value={v}>{l}</option>)}</NativeSelect>}</FormField>
          <FormField label="Client">{(a) => <NativeSelect {...a} {...form.register('clientId')}><option value="">Internal</option>{(clients.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</NativeSelect>}</FormField>
          <FormField label="Assignee">{(a) => <NativeSelect {...a} {...form.register('assigneeId')}><option value="">Unassigned</option>{(people.data?.data ?? []).map((p) => <option key={p.employeeId} value={p.employeeId}>{p.name}</option>)}</NativeSelect>}</FormField>
          <DialogFooter className="sm:col-span-2">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={create.isPending}>Open ticket</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function TicketsPage() {
  const params = useSearchParams();
  const canManage = useCan('tickets.manage');
  const [view, setView] = useState('open');
  const [creating, setCreating] = useState(false);
  const clientId = params.get('client') ?? undefined;
  const query = { ...(clientId ? { clientId } : {}), ...(view === 'open' ? { status: 'OPEN,IN_PROGRESS,WAITING_CLIENT' } : view === 'mine' ? { mine: 'true', status: 'OPEN,IN_PROGRESS,WAITING_CLIENT' } : view === 'breached' ? { breached: 'true' } : {}) };
  const tickets = useQuery({ queryKey: ticketKeys.list(query), queryFn: async () => (await api.get('/support-tickets', { query })).data });
  return (
    <>
      <PageHeader title="Support tickets" description="Client and internal requests with SLA tracking." actions={canManage ? <Button onClick={() => setCreating(true)}><Plus aria-hidden /> New ticket</Button> : null} />
      <NativeSelect aria-label="Show" value={view} onChange={(e) => setView(e.target.value)} className="mb-4 w-auto">
        <option value="open">Open</option>
        <option value="mine">Assigned to me</option>
        <option value="breached">Past SLA</option>
        <option value="all">All</option>
      </NativeSelect>
      <Card>
        <DataTable
          caption="Support tickets"
          rows={tickets.data ?? []}
          isPending={tickets.isPending}
          error={tickets.error}
          onRetry={() => tickets.refetch()}
          empty={<EmptyState icon={LifeBuoy} title="No tickets here" />}
          columns={[
            { key: 'subject', header: 'Ticket', cell: (t) => <Link href={`/tickets/${t.id}`} className="font-medium hover:underline">{t.key} · {t.subject}</Link> },
            { key: 'client', header: 'Client', cell: (t) => t.client?.name ?? 'Internal', className: 'hidden md:table-cell' },
            { key: 'priority', header: 'Priority', cell: (t) => <StatusBadge map={PRIORITY} value={t.priority} /> },
            { key: 'status', header: 'Status', cell: (t) => <StatusBadge map={TICKET_STATUS} value={t.status} /> },
            { key: 'sla', header: 'SLA', cell: (t) => <SlaBadge sla={t.sla} status={t.status} /> },
            { key: 'assignee', header: 'Assignee', cell: (t) => t.assignee?.name ?? '—', className: 'hidden lg:table-cell' },
          ]}
        />
      </Card>
      {creating ? <NewTicketDialog onClose={() => setCreating(false)} /> : null}
    </>
  );
}

export function TicketDetail({ ticketId }) {
  const ticket = useQuery({ queryKey: ticketKeys.one(ticketId), queryFn: async () => (await api.get(`/support-tickets/${ticketId}`)).data });
  const people = useEmployees({ status: 'ACTIVE', limit: 100, sort: 'name' });
  const teams = useTeams();
  const update = useAction((patch) => api.patch(`/support-tickets/${ticketId}`, patch), { success: 'Ticket updated', keys: [ticketKeys.all] });
  const form = useForm({ defaultValues: { body: '', visibility: 'PUBLIC' } });
  const comment = useAction((v) => api.post(`/support-tickets/${ticketId}/comments`, v), { success: (_d, v) => (v.visibility === 'PUBLIC' ? 'Reply sent' : 'Note added'), keys: [ticketKeys.all], onSuccess: () => form.reset({ body: '', visibility: form.getValues('visibility') }) });
  if (ticket.isPending) return <Skeleton className="h-96" role="status" aria-label="Loading ticket" />;
  if (ticket.error) return ticket.error.status === 404 ? <EmptyState title="Ticket not found" /> : <ErrorState error={ticket.error} />;
  const t = ticket.data;
  return (
    <>
      <PageHeader title={`${t.key} · ${t.subject}`} description={`${t.client?.name ?? 'Internal'} · opened by ${t.reporter?.name ?? 'unknown'} ${formatRelative(t.createdAt)}`} />
      <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
        <div className="grid content-start gap-6">
          <Card><CardContent className="pt-6 text-sm whitespace-pre-line">{t.description}</CardContent></Card>
          <CustomFieldsCard entity="TICKET" entityId={t.id} />
          <Card>
            <CardHeader><CardTitle>Conversation</CardTitle></CardHeader>
            <CardContent className="grid gap-4">
              <ol className="grid gap-3">
                {t.comments.map((c) => (
                  <li key={c.id} className={cn('rounded-md border p-3 text-sm', c.visibility === 'INTERNAL' && 'border-dashed bg-muted/60')}>
                    <p className="text-xs text-muted-foreground">
                      {c.author.name} · {formatDate(c.createdAt, { withTime: true })} · {c.visibility === 'INTERNAL' ? <span className="inline-flex items-center gap-1 font-medium"><Lock aria-hidden className="size-3" /> Internal note</span> : 'Public reply'}
                    </p>
                    <p className="mt-1 whitespace-pre-line">{c.body}</p>
                  </li>
                ))}
                {!t.comments.length ? <p className="text-sm text-muted-foreground">No replies yet.</p> : null}
              </ol>
              <form onSubmit={form.handleSubmit((v) => comment.mutate(v))} className="grid gap-3">
                <FormField label="Reply" required>{(a) => <Textarea rows={3} required {...a} {...form.register('body')} />}</FormField>
                <div className="flex flex-wrap items-center gap-3">
                  <NativeSelect aria-label="Visibility" className="w-auto" {...form.register('visibility')}>
                    {t.canManage ? <option value="PUBLIC">Reply to the client (public)</option> : null}
                    <option value="INTERNAL">Internal note (staff only)</option>
                  </NativeSelect>
                  <Button type="submit" disabled={comment.isPending}>Send</Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </div>
        <Card className="content-start">
          <CardContent className="grid gap-4 pt-6 text-sm">
            <div className="flex flex-wrap gap-2"><StatusBadge map={TICKET_STATUS} value={t.status} /><StatusBadge map={PRIORITY} value={t.priority} /><SlaBadge sla={t.sla} status={t.status} /></div>
            <dl className="grid gap-1 text-xs">
              <dt className="text-muted-foreground">First response due</dt><dd>{formatDate(t.sla.firstResponseDueAt, { withTime: true })}{t.sla.firstRespondedAt ? ` · answered ${formatDate(t.sla.firstRespondedAt, { withTime: true })}` : ''}{t.sla.firstResponseBreached ? ' (late)' : ''}</dd>
              <dt className="text-muted-foreground">Resolution due</dt><dd>{formatDate(t.sla.resolutionDueAt, { withTime: true })}</dd>
            </dl>
            {t.canManage ? (
              <>
                <FormField label="Status">{(a) => <NativeSelect {...a} value={t.status} onChange={(e) => update.mutate({ status: e.target.value, version: t.version })}>{Object.entries(TICKET_STATUS).map(([v, [l]]) => <option key={v} value={v}>{l}</option>)}</NativeSelect>}</FormField>
                <FormField label="Priority">{(a) => <NativeSelect {...a} value={t.priority} onChange={(e) => update.mutate({ priority: e.target.value, version: t.version })}>{Object.entries(PRIORITY).map(([v, [l]]) => <option key={v} value={v}>{l}</option>)}</NativeSelect>}</FormField>
                <FormField label="Assignee">{(a) => <NativeSelect {...a} value={t.assignee?.id ?? ''} onChange={(e) => update.mutate({ assigneeId: e.target.value || null, version: t.version })}><option value="">Unassigned</option>{(people.data?.data ?? []).map((p) => <option key={p.employeeId} value={p.employeeId}>{p.name}</option>)}</NativeSelect>}</FormField>
                <FormField label="Team">{(a) => <NativeSelect {...a} value={t.team?.id ?? ''} onChange={(e) => update.mutate({ teamId: e.target.value || null, version: t.version })}><option value="">No team</option>{(teams.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</NativeSelect>}</FormField>
              </>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
