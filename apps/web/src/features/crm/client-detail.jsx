'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { Mail, Phone, Plus, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, NativeSelect, Textarea } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FormField } from '@/components/common/form-field';
import { EmptyState, ErrorState } from '@/components/common/states';
import { useCan } from '@/features/session/session-provider';
import { api } from '@/lib/api';
import { formatDate, formatMoney } from '@/lib/format';
import { cn } from '@/lib/utils';
import { CLIENT_STATUS, COMM_KIND, INVOICE_STATUS, TICKET_STATUS } from './labels';
import { StatusBadge } from './status-badge';
import { crmKeys, newKey, useAction, useClient } from './queries';
import { CustomFieldsCard } from '@/features/custom-fields/custom-fields';

const get = (path) => async () => (await api.get(path)).data;

function ContactDialog({ clientId, onClose }) {
  const form = useForm({ defaultValues: { name: '', email: '', phone: '', title: '', isPrimary: false } });
  const add = useAction((v) => api.post(`/clients/${clientId}/contacts`, Object.fromEntries(Object.entries(v).filter(([, x]) => x !== ''))), { success: 'Contact added', onSuccess: onClose });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add contact</DialogTitle>
          <DialogDescription>People you deal with at this client.</DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit((v) => add.mutate(v))} className="grid gap-4 sm:grid-cols-2">
          <FormField label="Name" required>{(a) => <Input required {...a} {...form.register('name')} />}</FormField>
          <FormField label="Title">{(a) => <Input {...a} {...form.register('title')} />}</FormField>
          <FormField label="Email">{(a) => <Input type="email" {...a} {...form.register('email')} />}</FormField>
          <FormField label="Phone">{(a) => <Input {...a} {...form.register('phone')} />}</FormField>
          <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" className="size-4 accent-[var(--primary)]" {...form.register('isPrimary')} /> Primary contact</label>
          <DialogFooter className="sm:col-span-2">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={add.isPending}>Add</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Overview({ client }) {
  const [adding, setAdding] = useState(false);
  const remove = useAction((id) => api.delete(`/clients/${client.id}/contacts/${id}`), { success: 'Contact removed' });
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-2">
          <CardTitle>Contacts</CardTitle>
          {client.canManage ? <Button size="sm" variant="outline" onClick={() => setAdding(true)}><Plus aria-hidden /> Add</Button> : null}
        </CardHeader>
        <CardContent>
          {client.contacts.length ? (
            <ul className="divide-y">
              {client.contacts.map((c) => (
                <li key={c.id} className="flex flex-wrap items-start gap-3 py-3 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{c.name} {c.isPrimary ? <Badge tone="info">Primary</Badge> : null}</p>
                    {c.title ? <p className="text-muted-foreground">{c.title}</p> : null}
                    <p className="flex flex-wrap gap-3 text-muted-foreground">
                      {c.email ? <a href={`mailto:${c.email}`} className="inline-flex items-center gap-1 hover:underline"><Mail aria-hidden className="size-3.5" />{c.email}</a> : null}
                      {c.phone ? <span className="inline-flex items-center gap-1"><Phone aria-hidden className="size-3.5" />{c.phone}</span> : null}
                    </p>
                  </div>
                  {client.canManage ? <Button size="sm" variant="ghost" onClick={() => remove.mutate(c.id)}>Remove</Button> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No contacts yet.</p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Details</CardTitle></CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[9rem_1fr] gap-y-2 text-sm">
            <dt className="text-muted-foreground">Billing email</dt><dd>{client.email ?? '—'}</dd>
            <dt className="text-muted-foreground">Phone</dt><dd>{client.phone ?? '—'}</dd>
            <dt className="text-muted-foreground">Website</dt><dd>{client.website ?? '—'}</dd>
            <dt className="text-muted-foreground">Tax ID</dt><dd>{client.taxId ?? '—'}</dd>
            <dt className="text-muted-foreground">Payment terms</dt><dd>{client.paymentTermsDays} days</dd>
            <dt className="text-muted-foreground">Projects</dt>
            <dd>{client.projects.length ? client.projects.map((p) => <Link key={p.id} href={`/projects/${p.id}/overview`} className="mr-2 hover:underline">{p.code}{p.sharedWithClient ? ' (shared)' : ''}</Link>) : '—'}</dd>
            <dt className="text-muted-foreground">Open tickets</dt><dd><Link href={`/tickets?client=${client.id}`} className="hover:underline">{client.openTickets}</Link></dd>
            {client.outstanding ? (
              <>
                <dt className="text-muted-foreground">Outstanding</dt>
                <dd>{client.outstanding.length ? client.outstanding.map((o) => formatMoney(o.amount, o.currency)).join(' · ') : 'Nothing'}</dd>
              </>
            ) : null}
          </dl>
        </CardContent>
      </Card>
      <CustomFieldsCard entity="CLIENT" entityId={client.id} />
      {adding ? <ContactDialog clientId={client.id} onClose={() => setAdding(false)} /> : null}
    </div>
  );
}

function Communication({ clientId }) {
  const notes = useQuery({ queryKey: crmKeys.notes(clientId), queryFn: get(`/clients/${clientId}/notes`) });
  const form = useForm({ defaultValues: { kind: 'NOTE', body: '' } });
  const add = useAction((v) => api.post(`/clients/${clientId}/notes`, v), { success: 'Logged', onSuccess: () => form.reset({ kind: 'NOTE', body: '' }) });
  return (
    <Card>
      <CardHeader><CardTitle>Communication history</CardTitle></CardHeader>
      <CardContent className="grid gap-4">
        <form onSubmit={form.handleSubmit((v) => add.mutate(v))} className="grid gap-3 sm:grid-cols-[9rem_1fr_auto] sm:items-end">
          <FormField label="Kind">{(a) => <NativeSelect {...a} {...form.register('kind')}>{Object.entries(COMM_KIND).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</NativeSelect>}</FormField>
          <FormField label="What happened" required>{(a) => <Textarea rows={2} required {...a} {...form.register('body')} />}</FormField>
          <Button type="submit" disabled={add.isPending}>Log</Button>
        </form>
        {notes.isPending ? <Skeleton className="h-20" /> : notes.error ? <ErrorState error={notes.error} /> : (
          <ol className="grid gap-3">
            {notes.data.map((n) => (
              <li key={n.id} className="rounded-md border p-3 text-sm">
                <p className="text-xs text-muted-foreground">{COMM_KIND[n.kind]} · {n.author.name} · {formatDate(n.occurredAt, { withTime: true })}</p>
                <p className="mt-1 whitespace-pre-line">{n.body}</p>
              </li>
            ))}
            {!notes.data.length ? <p className="text-sm text-muted-foreground">Nothing logged yet.</p> : null}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

function Tickets({ clientId }) {
  const tickets = useQuery({ queryKey: ['tickets', { clientId }], queryFn: async () => (await api.get('/support-tickets', { query: { clientId } })).data });
  if (tickets.isPending) return <Skeleton className="h-24" />;
  if (tickets.error) return <ErrorState error={tickets.error} />;
  return (
    <Card>
      <CardContent className="pt-6">
        {tickets.data.length ? (
          <ul className="divide-y text-sm">
            {tickets.data.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-3 py-2">
                <Link href={`/tickets/${t.id}`} className="flex-1 font-medium hover:underline">{t.key} · {t.subject}</Link>
                <StatusBadge map={TICKET_STATUS} value={t.status} />
              </li>
            ))}
          </ul>
        ) : <EmptyState title="No tickets" />}
      </CardContent>
    </Card>
  );
}

function Invoices({ clientId }) {
  const invoices = useQuery({ queryKey: ['finance', 'invoices', { clientId }], queryFn: async () => (await api.get('/invoices', { query: { clientId } })).data });
  if (invoices.isPending) return <Skeleton className="h-24" />;
  if (invoices.error) return <ErrorState error={invoices.error} />;
  return (
    <Card>
      <CardContent className="pt-6">
        {invoices.data.length ? (
          <ul className="divide-y text-sm">
            {invoices.data.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-3 py-2">
                <Link href={`/invoices/${i.id}`} className="flex-1 font-medium hover:underline">{i.number ?? 'Draft'} · {formatMoney(i.total, i.currency)}</Link>
                <StatusBadge map={INVOICE_STATUS} value={i.status} />
                {i.overdue ? <Badge tone="danger">Overdue</Badge> : null}
              </li>
            ))}
          </ul>
        ) : <EmptyState title="No invoices" />}
      </CardContent>
    </Card>
  );
}

function Agreements({ clientId, canManage }) {
  const rows = useQuery({ queryKey: crmKeys.agreements(clientId), queryFn: get(`/clients/${clientId}/agreements`) });
  const form = useForm({ defaultValues: { name: '', startDate: '', endDate: '', status: 'ACTIVE' } });
  const add = useAction((v) => api.post(`/clients/${clientId}/agreements`, { name: v.name, startDate: v.startDate, endDate: v.endDate || null, status: v.status }), { success: 'Agreement added', onSuccess: () => form.reset() });
  return (
    <Card>
      <CardHeader><CardTitle>Service agreements</CardTitle></CardHeader>
      <CardContent className="grid gap-4">
        {canManage ? (
          <form onSubmit={form.handleSubmit((v) => add.mutate(v))} className="grid gap-3 sm:grid-cols-5 sm:items-end">
            <FormField label="Name" required>{(a) => <Input required {...a} {...form.register('name')} />}</FormField>
            <FormField label="Starts" required>{(a) => <Input type="date" required {...a} {...form.register('startDate')} />}</FormField>
            <FormField label="Ends">{(a) => <Input type="date" {...a} {...form.register('endDate')} />}</FormField>
            <FormField label="Status">{(a) => <NativeSelect {...a} {...form.register('status')}>{['DRAFT', 'ACTIVE', 'EXPIRED', 'TERMINATED'].map((s) => <option key={s} value={s}>{s.charAt(0) + s.slice(1).toLowerCase()}</option>)}</NativeSelect>}</FormField>
            <Button type="submit" disabled={add.isPending}>Add</Button>
          </form>
        ) : null}
        {rows.data?.length ? (
          <ul className="divide-y text-sm">
            {rows.data.map((a) => <li key={a.id} className="py-2"><span className="font-medium">{a.name}</span> · {a.startDate} – {a.endDate ?? 'open-ended'} · {a.status.toLowerCase()}</li>)}
          </ul>
        ) : <p className="text-sm text-muted-foreground">No agreements.</p>}
      </CardContent>
    </Card>
  );
}

function PortalUsers({ clientId }) {
  const users = useQuery({ queryKey: crmKeys.portalUsers(clientId), queryFn: get(`/clients/${clientId}/portal-users`) });
  const form = useForm({ defaultValues: { name: '', email: '' } });
  const invite = useAction((v) => api.post(`/clients/${clientId}/portal-users`, v, { idempotencyKey: newKey() }), { success: 'Invitation sent', onSuccess: () => form.reset() });
  const revoke = useAction((id) => api.post(`/clients/${clientId}/portal-users/${id}/revoke`), { success: 'Access removed' });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Client portal</CardTitle>
        <CardDescription>Portal users see only this client’s shared projects, their tickets (public replies) and issued invoices.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <form onSubmit={form.handleSubmit((v) => invite.mutate(v))} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <FormField label="Name" required>{(a) => <Input required {...a} {...form.register('name')} />}</FormField>
          <FormField label="Email" required>{(a) => <Input type="email" required {...a} {...form.register('email')} />}</FormField>
          <Button type="submit" disabled={invite.isPending}><UserPlus aria-hidden /> Invite</Button>
        </form>
        {users.data?.length ? (
          <ul className="divide-y text-sm">
            {users.data.map((u) => (
              <li key={u.id} className="flex flex-wrap items-center gap-3 py-2">
                <span className="flex-1">{u.name} · <span className="text-muted-foreground">{u.email}</span></span>
                <Badge tone={u.status === 'ACTIVE' ? 'success' : u.status === 'INVITED' ? 'info' : 'neutral'}>{u.status.charAt(0) + u.status.slice(1).toLowerCase()}</Badge>
                {u.status !== 'DEACTIVATED' ? <Button size="sm" variant="ghost" onClick={() => revoke.mutate(u.id)}>Remove access</Button> : null}
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-muted-foreground">Nobody has portal access.</p>}
      </CardContent>
    </Card>
  );
}

export function ClientDetail({ clientId }) {
  const client = useClient(clientId);
  const canFinance = useCan('finance.invoices.read');
  const canTickets = useCan('tickets.read');
  const [tab, setTab] = useState('overview');
  if (client.isPending) return <Skeleton className="h-96" role="status" aria-label="Loading client" />;
  if (client.error) return client.error.status === 404 ? <EmptyState title="Client not found" /> : <ErrorState error={client.error} onRetry={() => client.refetch()} />;
  const c = client.data;
  const tabs = [
    ['overview', 'Overview'],
    ['communication', 'Communication'],
    ...(canTickets ? [['tickets', 'Tickets']] : []),
    ...(canFinance ? [['invoices', 'Invoices']] : []),
    ['agreements', 'Agreements'],
    ...(c.canManage ? [['portal', 'Portal access']] : []),
  ];
  return (
    <>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{c.name}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span className="font-mono">{c.code}</span> <StatusBadge map={CLIENT_STATUS} value={c.status} /> {c.accountManager ? `· Account manager ${c.accountManager.name}` : ''} · {c.defaultCurrency}
          </p>
        </div>
      </div>
      <div role="tablist" aria-label="Client sections" className="mb-6 flex gap-1 overflow-x-auto border-b">
        {tabs.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={cn('h-10 border-b-2 px-3 text-sm whitespace-nowrap', tab === id ? 'border-primary font-medium text-primary' : 'border-transparent text-muted-foreground hover:text-foreground')}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'overview' ? <Overview client={c} /> : null}
      {tab === 'communication' ? <Communication clientId={c.id} /> : null}
      {tab === 'tickets' ? <Tickets clientId={c.id} /> : null}
      {tab === 'invoices' ? <Invoices clientId={c.id} /> : null}
      {tab === 'agreements' ? <Agreements clientId={c.id} canManage={c.canManage} /> : null}
      {tab === 'portal' ? <PortalUsers clientId={c.id} /> : null}
    </>
  );
}
