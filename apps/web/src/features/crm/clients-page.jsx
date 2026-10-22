'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { Building, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input, NativeSelect } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FormField } from '@/components/common/form-field';
import { PageHeader } from '@/components/common/page-header';
import { EmptyState } from '@/components/common/states';
import { DataTable } from '@/components/data-tables/data-table';
import { useCan, useMe } from '@/features/session/session-provider';
import { api } from '@/lib/api';
import { CLIENT_STATUS } from './labels';
import { StatusBadge } from './status-badge';
import { newKey, useAction, useClients } from './queries';

export function ClientDialog({ onClose }) {
  const me = useMe();
  const router = useRouter();
  const form = useForm({ defaultValues: { name: '', code: '', email: '', status: 'ACTIVE', defaultCurrency: me.organization.baseCurrency ?? 'USD', paymentTermsDays: 30 } });
  const create = useAction(
    (v) => api.post('/clients', { name: v.name, ...(v.code ? { code: v.code } : {}), ...(v.email ? { email: v.email } : {}), status: v.status, defaultCurrency: v.defaultCurrency.toUpperCase(), paymentTermsDays: Number(v.paymentTermsDays) }, { idempotencyKey: newKey() }),
    { success: 'Client created', onSuccess: ({ data }) => router.push(`/clients/${data.id}`) },
  );
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New client</DialogTitle>
          <DialogDescription>The code is generated from the name if you leave it empty.</DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit((v) => create.mutate(v))} className="grid gap-4 sm:grid-cols-2">
          <FormField label="Name" required>{(aria) => <Input required maxLength={200} {...aria} {...form.register('name')} />}</FormField>
          <FormField label="Code">{(aria) => <Input maxLength={32} {...aria} {...form.register('code')} />}</FormField>
          <FormField label="Billing email">{(aria) => <Input type="email" {...aria} {...form.register('email')} />}</FormField>
          <FormField label="Status">
            {(aria) => (
              <NativeSelect {...aria} {...form.register('status')}>
                {Object.entries(CLIENT_STATUS).map(([v, [l]]) => <option key={v} value={v}>{l}</option>)}
              </NativeSelect>
            )}
          </FormField>
          <FormField label="Currency" hint="ISO code, e.g. USD">{(aria) => <Input required pattern="[A-Za-z]{3}" maxLength={3} {...aria} {...form.register('defaultCurrency')} />}</FormField>
          <FormField label="Payment terms (days)">{(aria) => <Input type="number" min={0} max={365} {...aria} {...form.register('paymentTermsDays')} />}</FormField>
          <DialogFooter className="sm:col-span-2">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={create.isPending}>Create client</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ClientsPage() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);
  const canManage = useCan('clients.manage');
  const clients = useClients({ ...(q ? { q } : {}), ...(status ? { status } : {}) });
  return (
    <>
      <PageHeader
        title="Clients"
        description="Organizations you work for: contacts, communication, projects, tickets and billing."
        actions={canManage ? <Button onClick={() => setCreating(true)}><Plus aria-hidden /> New client</Button> : null}
      />
      <div className="mb-4 flex flex-wrap gap-3">
        <Input type="search" aria-label="Search clients" placeholder="Search name, code or email" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" />
        <NativeSelect aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className="w-auto">
          <option value="">All statuses</option>
          {Object.entries(CLIENT_STATUS).map(([v, [l]]) => <option key={v} value={v}>{l}</option>)}
        </NativeSelect>
      </div>
      <Card>
        <DataTable
          caption="Clients"
          rows={clients.data ?? []}
          isPending={clients.isPending}
          error={clients.error}
          onRetry={() => clients.refetch()}
          empty={<EmptyState icon={Building} title="No clients" description={canManage ? 'Create your first client.' : 'Clients of projects you manage appear here.'} />}
          columns={[
            { key: 'name', header: 'Client', cell: (c) => <Link href={`/clients/${c.id}`} className="font-medium hover:underline">{c.name}</Link> },
            { key: 'code', header: 'Code', cell: (c) => <span className="font-mono text-xs">{c.code}</span> },
            { key: 'status', header: 'Status', cell: (c) => <StatusBadge map={CLIENT_STATUS} value={c.status} /> },
            { key: 'manager', header: 'Account manager', cell: (c) => c.accountManager?.name ?? '—', className: 'hidden md:table-cell' },
            { key: 'currency', header: 'Currency', cell: (c) => c.defaultCurrency, className: 'hidden sm:table-cell' },
          ]}
        />
      </Card>
      {creating ? <ClientDialog onClose={() => setCreating(false)} /> : null}
    </>
  );
}
