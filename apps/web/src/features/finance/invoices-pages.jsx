'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { Download, Plus, Receipt } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, NativeSelect, Textarea } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FormField } from '@/components/common/form-field';
import { PageHeader } from '@/components/common/page-header';
import { EmptyState, ErrorState } from '@/components/common/states';
import { DataTable } from '@/components/data-tables/data-table';
import { useCan, useMe } from '@/features/session/session-provider';
import { api } from '@/lib/api';
import { addDays, formatDate, formatMoney, todayIn } from '@/lib/format';
import { INVOICE_STATUS } from '@/features/crm/labels';
import { StatusBadge } from '@/features/crm/status-badge';
import { newKey, useAction, useClients } from '@/features/crm/queries';
import { LineFields, TotalsTable, percentToRate } from '@/features/crm/sales-pages';

export const financeKeys = { all: ['finance'], invoices: (p) => ['finance', 'invoices', p], invoice: (id) => ['finance', 'invoice', id] };

export function InvoiceStatus({ invoice }) {
  return (
    <span className="inline-flex flex-wrap gap-1">
      <StatusBadge map={INVOICE_STATUS} value={invoice.status} />
      {invoice.overdue ? <Badge tone="danger">Overdue</Badge> : null}
    </span>
  );
}

/** Downloads a PDF through the API (session cookie) and saves it. */
export async function downloadPdf(path, fileName) {
  const res = await fetch(`/api/v1${path}`, { credentials: 'same-origin' });
  if (!res.ok) return toast.error('The PDF could not be generated');
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: fileName });
  a.click();
  URL.revokeObjectURL(url);
}

function NewInvoiceDialog({ onClose }) {
  const router = useRouter();
  const clients = useClients();
  const form = useForm({ defaultValues: { clientId: '' } });
  const create = useAction((v) => api.post('/invoices', { clientId: v.clientId }, { idempotencyKey: newKey() }), { keys: [financeKeys.all], onSuccess: ({ data }) => router.push(`/invoices/${data.id}`) });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>New invoice</DialogTitle><DialogDescription>Start a draft; add time, expenses or manual lines next.</DialogDescription></DialogHeader>
        <form onSubmit={form.handleSubmit((v) => create.mutate(v))} className="grid gap-4">
          <FormField label="Client" required>{(a) => <NativeSelect required {...a} {...form.register('clientId')}><option value="">Choose…</option>{(clients.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name} ({c.defaultCurrency})</option>)}</NativeSelect>}</FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={create.isPending}>Create draft</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function InvoicesPage() {
  const canManage = useCan('finance.invoices.manage');
  const [view, setView] = useState('open');
  const [creating, setCreating] = useState(false);
  const query = view === 'open' ? { status: 'ISSUED,PARTIALLY_PAID' } : view === 'overdue' ? { overdue: 'true' } : view === 'draft' ? { status: 'DRAFT' } : {};
  const invoices = useQuery({ queryKey: financeKeys.invoices(query), queryFn: async () => (await api.get('/invoices', { query })).data });
  return (
    <>
      <PageHeader title="Invoices" description="Billed from approved time, expenses and manual lines. Paid only when payments cover the total." actions={canManage ? <Button onClick={() => setCreating(true)}><Plus aria-hidden /> New invoice</Button> : null} />
      <NativeSelect aria-label="Show" value={view} onChange={(e) => setView(e.target.value)} className="mb-4 w-auto">
        <option value="open">Unpaid</option>
        <option value="overdue">Overdue</option>
        <option value="draft">Drafts</option>
        <option value="all">All</option>
      </NativeSelect>
      <Card>
        <DataTable
          caption="Invoices"
          rows={invoices.data ?? []}
          isPending={invoices.isPending}
          error={invoices.error}
          onRetry={() => invoices.refetch()}
          empty={<EmptyState icon={Receipt} title="No invoices here" />}
          columns={[
            { key: 'number', header: 'Invoice', cell: (i) => <Link href={`/invoices/${i.id}`} className="font-medium hover:underline">{i.number ?? 'Draft'}</Link> },
            { key: 'client', header: 'Client', cell: (i) => i.client?.name },
            { key: 'due', header: 'Due', cell: (i) => formatDate(i.dueDate), className: 'hidden md:table-cell' },
            { key: 'total', header: 'Total', cell: (i) => formatMoney(i.total, i.currency), className: 'text-right tabular-nums' },
            { key: 'outstanding', header: 'Outstanding', cell: (i) => formatMoney(i.outstanding, i.currency), className: 'hidden sm:table-cell text-right tabular-nums' },
            { key: 'status', header: 'Status', cell: (i) => <InvoiceStatus invoice={i} /> },
          ]}
        />
      </Card>
      {creating ? <NewInvoiceDialog onClose={() => setCreating(false)} /> : null}
    </>
  );
}

function AddTime({ invoice }) {
  const me = useMe();
  const today = todayIn(me.organization.timeZone);
  const [range, setRange] = useState({ from: addDays(today, -30), to: today, groupBy: 'member' });
  const preview = useQuery({
    queryKey: ['finance', 'billable-time', invoice.client.id, range],
    queryFn: async () => (await api.get('/invoices/billable-time', { query: { clientId: invoice.client.id, currency: invoice.currency, ...range, ...(invoice.projectId ? { projectId: invoice.projectId } : {}) } })).data,
  });
  const add = useAction(() => api.post(`/invoices/${invoice.id}/time`, range, { idempotencyKey: newKey() }), { success: 'Time added', keys: [financeKeys.all] });
  const p = preview.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Bill approved time</CardTitle>
        <CardDescription>Billable time from approved timesheets that is not on any invoice, priced with the rate in force on each day.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="grid gap-1.5 text-sm font-medium">From<Input type="date" value={range.from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} /></label>
          <label className="grid gap-1.5 text-sm font-medium">To<Input type="date" value={range.to} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} /></label>
          <label className="grid gap-1.5 text-sm font-medium">One line per<NativeSelect value={range.groupBy} onChange={(e) => setRange((r) => ({ ...r, groupBy: e.target.value }))}><option value="member">Person and project</option><option value="project">Project</option><option value="entry">Time entry</option></NativeSelect></label>
        </div>
        {preview.isPending ? <Skeleton className="h-16" /> : preview.error ? <ErrorState error={preview.error} /> : (
          <>
            {p.lines.length ? (
              <ul className="divide-y text-sm">
                {p.lines.map((l, i) => (
                  <li key={i} className="flex flex-wrap justify-between gap-2 py-2">
                    <span>{l.project.code}{l.employee ? ` · ${l.employee.name}` : ''} · {Number(l.hours)} h × {formatMoney(l.rate, p.currency)}</span>
                    <span className="tabular-nums">{formatMoney(l.lineTotal, p.currency)}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-muted-foreground">Nothing to bill in this period.</p>}
            {p.skipped.noRate || p.skipped.otherCurrency ? (
              <p className="text-sm text-warning">Not billable yet: {p.skipped.noRate} entries without a billing rate, {p.skipped.otherCurrency} priced in another currency.</p>
            ) : null}
            <Button className="justify-self-start" disabled={!p.lines.length || add.isPending} onClick={() => add.mutate()}>Add to invoice</Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function AddExpenses({ invoice }) {
  const expenses = useQuery({ queryKey: ['finance', 'billable-expenses', invoice.id], queryFn: async () => (await api.get(`/invoices/${invoice.id}/billable-expenses`)).data });
  const [picked, setPicked] = useState([]);
  const add = useAction(() => api.post(`/invoices/${invoice.id}/expenses`, { expenseIds: picked }, { idempotencyKey: newKey() }), { success: 'Expenses added', keys: [financeKeys.all], onSuccess: () => setPicked([]) });
  if (!expenses.data?.length) return null;
  return (
    <Card>
      <CardHeader><CardTitle>Bill approved expenses</CardTitle></CardHeader>
      <CardContent className="grid gap-3">
        <fieldset className="grid gap-2">
          <legend className="sr-only">Expenses</legend>
          {expenses.data.map((e) => (
            <label key={e.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="size-4 accent-[var(--primary)]" disabled={!e.sameCurrency} checked={picked.includes(e.id)} onChange={(ev) => setPicked((p) => (ev.target.checked ? [...p, e.id] : p.filter((x) => x !== e.id)))} />
              {e.incurredOn} · {e.description} · {formatMoney(e.amount, e.currency)}{e.sameCurrency ? '' : ' (different currency)'}
            </label>
          ))}
        </fieldset>
        <Button className="justify-self-start" disabled={!picked.length || add.isPending} onClick={() => add.mutate()}>Add selected</Button>
      </CardContent>
    </Card>
  );
}

function ManualLines({ invoice }) {
  const form = useForm({ defaultValues: { items: [{ description: '', quantity: '1', unitPrice: '', taxPercent: '0' }] } });
  const add = useAction(async (v) => {
    for (const i of v.items) await api.post(`/invoices/${invoice.id}/items`, { description: i.description, quantity: i.quantity, unitPrice: i.unitPrice, taxRate: percentToRate(i.taxPercent) });
  }, { success: 'Lines added', keys: [financeKeys.all], onSuccess: () => form.reset({ items: [{ description: '', quantity: '1', unitPrice: '', taxPercent: '0' }] }) });
  return (
    <Card>
      <CardHeader><CardTitle>Manual lines</CardTitle></CardHeader>
      <CardContent>
        <form onSubmit={form.handleSubmit((v) => add.mutate(v))} className="grid gap-3">
          <LineFields form={form} />
          <Button type="submit" className="justify-self-start" disabled={add.isPending}>Add lines</Button>
        </form>
      </CardContent>
    </Card>
  );
}

function PaymentDialog({ invoice, onClose }) {
  const me = useMe();
  const form = useForm({ defaultValues: { amount: invoice.outstanding, receivedOn: todayIn(me.organization.timeZone), method: 'BANK_TRANSFER', reference: '' } });
  const pay = useAction((v) => api.post(`/invoices/${invoice.id}/payments`, { ...v, ...(v.reference ? {} : { reference: undefined }) }, { idempotencyKey: newKey() }), { success: 'Payment recorded', keys: [financeKeys.all], onSuccess: onClose });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Record a payment</DialogTitle><DialogDescription>Outstanding {formatMoney(invoice.outstanding, invoice.currency)}. Use a negative amount for a refund.</DialogDescription></DialogHeader>
        <form onSubmit={form.handleSubmit((v) => pay.mutate(v))} className="grid gap-4 sm:grid-cols-2">
          <FormField label={`Amount (${invoice.currency})`} required>{(a) => <Input required inputMode="decimal" pattern="-?\d+(\.\d{1,4})?" {...a} {...form.register('amount')} />}</FormField>
          <FormField label="Received on" required>{(a) => <Input type="date" required {...a} {...form.register('receivedOn')} />}</FormField>
          <FormField label="Method">{(a) => <NativeSelect {...a} {...form.register('method')}>{[['BANK_TRANSFER', 'Bank transfer'], ['CARD', 'Card'], ['CASH', 'Cash'], ['CHEQUE', 'Cheque'], ['OTHER', 'Other']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</NativeSelect>}</FormField>
          <FormField label="Reference">{(a) => <Input maxLength={120} {...a} {...form.register('reference')} />}</FormField>
          <DialogFooter className="sm:col-span-2">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={pay.isPending}>Record</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function InvoiceDetail({ invoiceId }) {
  const router = useRouter();
  const canManage = useCan('finance.invoices.manage');
  const canPay = useCan('finance.payments.record');
  const [paying, setPaying] = useState(false);
  const invoice = useQuery({ queryKey: financeKeys.invoice(invoiceId), queryFn: async () => (await api.get(`/invoices/${invoiceId}`)).data });
  const issue = useAction(() => api.post(`/invoices/${invoiceId}/issue`, {}, { idempotencyKey: newKey() }), { success: (r) => `Issued ${r.data.number}`, keys: [financeKeys.all] });
  const voidIt = useAction((reason) => api.post(`/invoices/${invoiceId}/void`, { reason }), { success: 'Invoice voided', keys: [financeKeys.all] });
  const remove = useAction(() => api.delete(`/invoices/${invoiceId}`), { success: 'Draft deleted', keys: [financeKeys.all], onSuccess: () => router.push('/invoices') });
  const removeLine = useAction((itemId) => api.delete(`/invoices/${invoiceId}/items/${itemId}`), { keys: [financeKeys.all] });
  const notes = useAction((value) => api.patch(`/invoices/${invoiceId}`, { notes: value || null }), { success: 'Notes saved', keys: [financeKeys.all] });
  if (invoice.isPending) return <Skeleton className="h-96" role="status" aria-label="Loading invoice" />;
  if (invoice.error) return invoice.error.status === 404 ? <EmptyState title="Invoice not found" /> : <ErrorState error={invoice.error} />;
  const inv = invoice.data;
  const draft = inv.status === 'DRAFT';
  return (
    <>
      <PageHeader
        title={inv.number ? `Invoice ${inv.number}` : 'Draft invoice'}
        description={<span className="inline-flex flex-wrap items-center gap-2">{inv.client.name} · <InvoiceStatus invoice={inv} />{inv.issueDate ? ` · issued ${formatDate(inv.issueDate)} · due ${formatDate(inv.dueDate)}` : ''}</span>}
        actions={
          <span className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => downloadPdf(`/invoices/${inv.id}/pdf`, `${inv.number ?? 'draft-invoice'}.pdf`)}><Download aria-hidden /> PDF</Button>
            {draft && canManage ? <><Button disabled={!inv.items.length || issue.isPending} onClick={() => issue.mutate()}>Issue</Button><Button variant="outline" onClick={() => window.confirm('Delete this draft?') && remove.mutate()}>Delete</Button></> : null}
            {['ISSUED', 'PARTIALLY_PAID', 'PAID'].includes(inv.status) && canPay ? <Button onClick={() => setPaying(true)}>Record payment</Button> : null}
            {['ISSUED', 'PARTIALLY_PAID'].includes(inv.status) && canManage ? <Button variant="outline" onClick={() => { const r = window.prompt('Why is this invoice void?'); if (r) voidIt.mutate(r); }}>Void</Button> : null}
          </span>
        }
      />
      <div className="grid gap-6">
        <Card>
          <CardContent className="pt-6">
            {inv.items.length ? <TotalsTable doc={inv} caption="Invoice lines" /> : <EmptyState title="No lines yet" description="Add approved time, expenses or manual lines below." />}
            {draft && inv.items.length ? (
              <ul className="mt-3 flex flex-wrap gap-2">
                {inv.items.map((i) => <li key={i.id}><Button size="sm" variant="ghost" onClick={() => removeLine.mutate(i.id)}>Remove “{i.description.slice(0, 30)}”</Button></li>)}
              </ul>
            ) : null}
            {!draft ? (
              <dl className="mt-4 grid grid-cols-2 gap-2 text-sm sm:max-w-sm sm:justify-self-end">
                <dt className="text-muted-foreground">Paid</dt><dd className="text-right tabular-nums">{formatMoney(inv.amountPaid, inv.currency)}</dd>
                <dt className="font-medium">Outstanding</dt><dd className="text-right font-medium tabular-nums">{formatMoney(inv.outstanding, inv.currency)}</dd>
              </dl>
            ) : null}
          </CardContent>
        </Card>
        {draft && canManage ? (
          <>
            <AddTime invoice={inv} />
            <AddExpenses invoice={inv} />
            <ManualLines invoice={inv} />
            <Card>
              <CardHeader><CardTitle>Notes on the invoice</CardTitle></CardHeader>
              <CardContent>
                <form onSubmit={(e) => (e.preventDefault(), notes.mutate(new FormData(e.currentTarget).get('notes')))} className="grid gap-3">
                  <Textarea name="notes" aria-label="Notes" rows={3} defaultValue={inv.notes ?? ''} />
                  <Button type="submit" variant="outline" className="justify-self-start">Save notes</Button>
                </form>
              </CardContent>
            </Card>
          </>
        ) : null}
        {inv.payments?.length ? (
          <Card>
            <CardHeader><CardTitle>Payments</CardTitle><CardDescription>A ledger: corrections are recorded as refunds.</CardDescription></CardHeader>
            <CardContent>
              <ul className="divide-y text-sm">
                {inv.payments.map((p) => <li key={p.id} className="flex flex-wrap justify-between gap-2 py-2"><span>{formatDate(p.receivedOn)} · {p.method.replace('_', ' ').toLowerCase()}{p.reference ? ` · ${p.reference}` : ''}</span><span className="tabular-nums">{formatMoney(p.amount, inv.currency)}</span></li>)}
              </ul>
            </CardContent>
          </Card>
        ) : null}
      </div>
      {paying ? <PaymentDialog invoice={inv} onClose={() => setPaying(false)} /> : null}
    </>
  );
}
