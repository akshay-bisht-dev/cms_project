'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { Download, LifeBuoy, Plus, Receipt } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, NativeSelect, Textarea } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { FormField } from '@/components/common/form-field';
import { PageHeader } from '@/components/common/page-header';
import { EmptyState, ErrorState } from '@/components/common/states';
import { DataTable } from '@/components/data-tables/data-table';
import { api } from '@/lib/api';
import { formatDate, formatMoney, formatRelative } from '@/lib/format';
import { PRIORITY, TICKET_STATUS } from '@/features/crm/labels';
import { StatusBadge } from '@/features/crm/status-badge';
import { newKey, useAction } from '@/features/crm/queries';
import { InvoiceStatus, downloadPdf } from '@/features/finance/invoices-pages';
import { SlaBadge } from '@/features/tickets/tickets-pages';

const keys = { all: ['portal'], overview: ['portal', 'overview'], projects: ['portal', 'projects'], tickets: ['portal', 'tickets'], ticket: (id) => ['portal', 'ticket', id], invoices: ['portal', 'invoices'] };
const get = (path) => async () => (await api.get(path)).data;

export function PortalOverview() {
  const overview = useQuery({ queryKey: keys.overview, queryFn: get('/portal') });
  const projects = useQuery({ queryKey: keys.projects, queryFn: get('/portal/projects') });
  if (overview.isPending) return <Skeleton className="h-64" role="status" aria-label="Loading" />;
  if (overview.error) return <ErrorState error={overview.error} />;
  const o = overview.data;
  return (
    <>
      <PageHeader title={`Welcome, ${o.client.name}`} description={`Your work with ${o.organization.name}.`} />
      <div className="mb-6 grid gap-3 sm:grid-cols-2">
        <Link href="/portal/tickets" className="rounded-lg border bg-card p-4 hover:bg-muted/50">
          <p className="text-sm text-muted-foreground">Open support tickets</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{o.openTickets}</p>
        </Link>
        <Link href="/portal/invoices" className="rounded-lg border bg-card p-4 hover:bg-muted/50">
          <p className="text-sm text-muted-foreground">Unpaid invoices</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{o.unpaidInvoices}</p>
        </Link>
      </div>
      <Card>
        <CardHeader><CardTitle>Projects</CardTitle></CardHeader>
        <CardContent>
          {projects.data?.length ? (
            <ul className="grid gap-4">
              {projects.data.map((p) => (
                <li key={p.id} className="rounded-md border p-4">
                  <p className="font-medium">{p.name} <span className="text-sm font-normal text-muted-foreground">· {p.status.toLowerCase().replace('_', ' ')}{p.deadline ? ` · deadline ${formatDate(p.deadline)}` : ''}</span></p>
                  {p.milestones.length ? (
                    <ul className="mt-2 grid gap-1 text-sm">
                      {p.milestones.map((m) => <li key={m.name}>{m.done ? 'Done' : 'Upcoming'}: {m.name}{m.dueDate ? ` (${formatDate(m.dueDate)})` : ''}</li>)}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-muted-foreground">No projects are shared with you yet.</p>}
        </CardContent>
      </Card>
    </>
  );
}

function NewTicket({ onDone }) {
  const router = useRouter();
  const form = useForm({ defaultValues: { subject: '', description: '', priority: 'NORMAL' } });
  const create = useAction((v) => api.post('/portal/tickets', v, { idempotencyKey: newKey() }), { success: 'Ticket raised', keys: [keys.all], onSuccess: ({ data }) => router.push(`/portal/tickets/${data.id}`) });
  return (
    <Card className="mb-6">
      <CardHeader><CardTitle>Raise a ticket</CardTitle></CardHeader>
      <CardContent>
        <form onSubmit={form.handleSubmit((v) => create.mutate(v))} className="grid gap-4 sm:grid-cols-[1fr_10rem]">
          <FormField label="Subject" required>{(a) => <Input required maxLength={200} {...a} {...form.register('subject')} />}</FormField>
          <FormField label="Priority">{(a) => <NativeSelect {...a} {...form.register('priority')}>{Object.entries(PRIORITY).map(([v, [l]]) => <option key={v} value={v}>{l}</option>)}</NativeSelect>}</FormField>
          <div className="sm:col-span-2"><FormField label="What do you need?" required>{(a) => <Textarea rows={4} required {...a} {...form.register('description')} />}</FormField></div>
          <div className="flex gap-2 sm:col-span-2">
            <Button type="submit" disabled={create.isPending}>Send</Button>
            <Button type="button" variant="outline" onClick={onDone}>Cancel</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export function PortalTickets() {
  const [creating, setCreating] = useState(false);
  const tickets = useQuery({ queryKey: keys.tickets, queryFn: get('/portal/tickets') });
  return (
    <>
      <PageHeader title="Support" description="Requests from your organization and our replies." actions={!creating ? <Button onClick={() => setCreating(true)}><Plus aria-hidden /> Raise a ticket</Button> : null} />
      {creating ? <NewTicket onDone={() => setCreating(false)} /> : null}
      <Card>
        <DataTable
          caption="Your tickets"
          rows={tickets.data ?? []}
          isPending={tickets.isPending}
          error={tickets.error}
          onRetry={() => tickets.refetch()}
          empty={<EmptyState icon={LifeBuoy} title="No tickets yet" />}
          columns={[
            { key: 'subject', header: 'Ticket', cell: (t) => <Link href={`/portal/tickets/${t.id}`} className="font-medium hover:underline">{t.key} · {t.subject}</Link> },
            { key: 'status', header: 'Status', cell: (t) => <StatusBadge map={TICKET_STATUS} value={t.status} /> },
            { key: 'updated', header: 'Updated', cell: (t) => formatRelative(t.updatedAt), className: 'hidden sm:table-cell' },
          ]}
        />
      </Card>
    </>
  );
}

export function PortalTicket({ ticketId }) {
  const ticket = useQuery({ queryKey: keys.ticket(ticketId), queryFn: get(`/portal/tickets/${ticketId}`) });
  const form = useForm({ defaultValues: { body: '' } });
  const reply = useAction((v) => api.post(`/portal/tickets/${ticketId}/comments`, v), { success: 'Reply sent', keys: [keys.all], onSuccess: () => form.reset() });
  if (ticket.isPending) return <Skeleton className="h-64" role="status" aria-label="Loading ticket" />;
  if (ticket.error) return ticket.error.status === 404 ? <EmptyState title="Ticket not found" /> : <ErrorState error={ticket.error} />;
  const t = ticket.data;
  return (
    <>
      <PageHeader title={`${t.key} · ${t.subject}`} description={<span className="inline-flex flex-wrap items-center gap-2"><StatusBadge map={TICKET_STATUS} value={t.status} /> <StatusBadge map={PRIORITY} value={t.priority} /> <SlaBadge sla={t.sla} status={t.status} /></span>} />
      <Card className="mb-6"><CardContent className="pt-6 text-sm whitespace-pre-line">{t.description}</CardContent></Card>
      <Card>
        <CardHeader><CardTitle>Conversation</CardTitle></CardHeader>
        <CardContent className="grid gap-4">
          <ol className="grid gap-3">
            {t.comments.map((c) => (
              <li key={c.id} className="rounded-md border p-3 text-sm">
                <p className="text-xs text-muted-foreground">{c.author.name} · {formatDate(c.createdAt, { withTime: true })}</p>
                <p className="mt-1 whitespace-pre-line">{c.body}</p>
              </li>
            ))}
            {!t.comments.length ? <p className="text-sm text-muted-foreground">No replies yet. We will answer here.</p> : null}
          </ol>
          {t.status !== 'CLOSED' ? (
            <form onSubmit={form.handleSubmit((v) => reply.mutate(v))} className="grid gap-3">
              <FormField label="Your reply" required>{(a) => <Textarea rows={3} required {...a} {...form.register('body')} />}</FormField>
              <Button type="submit" className="justify-self-start" disabled={reply.isPending}>Send</Button>
            </form>
          ) : <p className="text-sm text-muted-foreground">This ticket is closed. Raise a new one if you need more help.</p>}
        </CardContent>
      </Card>
    </>
  );
}

export function PortalInvoices() {
  const invoices = useQuery({ queryKey: keys.invoices, queryFn: get('/portal/invoices') });
  return (
    <>
      <PageHeader title="Invoices" description="Invoices issued to your organization." />
      <Card>
        <DataTable
          caption="Invoices"
          scrollable
          rows={invoices.data ?? []}
          isPending={invoices.isPending}
          error={invoices.error}
          onRetry={() => invoices.refetch()}
          empty={<EmptyState icon={Receipt} title="No invoices" />}
          columns={[
            { key: 'number', header: 'Invoice', cell: (i) => <span className="font-medium">{i.number}</span> },
            { key: 'issued', header: 'Issued', cell: (i) => formatDate(i.issueDate), className: 'hidden sm:table-cell' },
            { key: 'due', header: 'Due', cell: (i) => formatDate(i.dueDate) },
            { key: 'total', header: 'Total', cell: (i) => formatMoney(i.total, i.currency), className: 'text-right tabular-nums' },
            { key: 'outstanding', header: 'To pay', cell: (i) => formatMoney(i.outstanding, i.currency), className: 'text-right tabular-nums' },
            { key: 'status', header: 'Status', cell: (i) => <InvoiceStatus invoice={i} /> },
            { key: 'pdf', header: <span className="sr-only">Download</span>, cell: (i) => <Button size="sm" variant="ghost" onClick={() => downloadPdf(`/portal/invoices/${i.id}/pdf`, `${i.number}.pdf`)}><Download aria-hidden /> PDF<span className="sr-only"> of {i.number}</span></Button> },
          ]}
        />
      </Card>
    </>
  );
}
