'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useFieldArray, useForm } from 'react-hook-form';
import { FileText, Plus, Trash2, UserRoundPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, NativeSelect, Textarea } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FormField } from '@/components/common/form-field';
import { PageHeader } from '@/components/common/page-header';
import { EmptyState, ErrorState } from '@/components/common/states';
import { DataTable } from '@/components/data-tables/data-table';
import { useMe } from '@/features/session/session-provider';
import { api } from '@/lib/api';
import { formatDate, formatMoney, todayIn } from '@/lib/format';
import { LEAD_NEXT, LEAD_STATUS, QUOTE_STATUS } from './labels';
import { StatusBadge } from './status-badge';
import { crmKeys, newKey, useAction, useClients, useStages } from './queries';

// ─── leads ────────────────────────────────────────────────────────────────

function LeadDialog({ onClose }) {
  const me = useMe();
  const form = useForm({ defaultValues: { name: '', company: '', email: '', phone: '', source: '', estimatedValue: '', currency: me.organization.baseCurrency ?? 'USD' } });
  const create = useAction(
    (v) => api.post('/leads', { ...Object.fromEntries(Object.entries(v).filter(([k, x]) => x !== '' && k !== 'currency')), ...(v.estimatedValue ? { currency: v.currency.toUpperCase() } : {}) }, { idempotencyKey: newKey() }),
    { success: 'Lead added', onSuccess: onClose },
  );
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>New lead</DialogTitle><DialogDescription>Someone who might become a client.</DialogDescription></DialogHeader>
        <form onSubmit={form.handleSubmit((v) => create.mutate(v))} className="grid gap-4 sm:grid-cols-2">
          <FormField label="Name" required>{(a) => <Input required {...a} {...form.register('name')} />}</FormField>
          <FormField label="Company">{(a) => <Input {...a} {...form.register('company')} />}</FormField>
          <FormField label="Email">{(a) => <Input type="email" {...a} {...form.register('email')} />}</FormField>
          <FormField label="Phone">{(a) => <Input {...a} {...form.register('phone')} />}</FormField>
          <FormField label="Source" hint="e.g. Website, Referral">{(a) => <Input {...a} {...form.register('source')} />}</FormField>
          <div className="grid grid-cols-[1fr_6rem] gap-2">
            <FormField label="Estimated value">{(a) => <Input inputMode="decimal" pattern="\d+(\.\d{1,2})?" {...a} {...form.register('estimatedValue')} />}</FormField>
            <FormField label="Currency">{(a) => <Input maxLength={3} {...a} {...form.register('currency')} />}</FormField>
          </div>
          <DialogFooter className="sm:col-span-2">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={create.isPending}>Add lead</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ConvertDialog({ lead, onClose }) {
  const router = useRouter();
  const form = useForm({ defaultValues: { clientName: lead.company ?? lead.name, createOpportunity: true } });
  const convert = useAction((v) => api.post(`/leads/${lead.id}/convert`, { clientName: v.clientName, createOpportunity: v.createOpportunity }, { idempotencyKey: newKey() }), {
    success: 'Lead converted',
    onSuccess: ({ data }) => router.push(`/clients/${data.client.id}`),
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Convert {lead.name}</DialogTitle>
          <DialogDescription>Creates a client with {lead.name} as its primary contact{lead.estimatedValue ? `, and an opportunity worth ${formatMoney(lead.estimatedValue, lead.currency)}` : ''}.</DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit((v) => convert.mutate(v))} className="grid gap-4">
          <FormField label="Client name" required>{(a) => <Input required {...a} {...form.register('clientName')} />}</FormField>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="size-4 accent-[var(--primary)]" {...form.register('createOpportunity')} /> Create an opportunity in the pipeline</label>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={convert.isPending}>Convert</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function LeadsPage() {
  const [status, setStatus] = useState('NEW,CONTACTED,QUALIFIED');
  const [creating, setCreating] = useState(false);
  const [converting, setConverting] = useState(null);
  const leads = useQuery({ queryKey: crmKeys.leads({ status }), queryFn: async () => (await api.get('/leads', { query: status ? { status } : undefined })).data });
  const move = useAction(({ id, to, lostReason }) => api.patch(`/leads/${id}`, { status: to, ...(lostReason ? { lostReason } : {}) }), { success: 'Lead updated' });
  function changeStatus(lead, to) {
    if (to === 'LOST') {
      const reason = window.prompt('Why was this lead lost?');
      if (!reason) return;
      move.mutate({ id: lead.id, to, lostReason: reason });
    } else move.mutate({ id: lead.id, to });
  }
  return (
    <>
      <PageHeader title="Leads" description="Prospects before they become clients." actions={<Button onClick={() => setCreating(true)}><Plus aria-hidden /> New lead</Button>} />
      <NativeSelect aria-label="Show" value={status} onChange={(e) => setStatus(e.target.value)} className="mb-4 w-auto">
        <option value="NEW,CONTACTED,QUALIFIED">Open leads</option>
        <option value="CONVERTED">Converted</option>
        <option value="LOST,UNQUALIFIED">Lost or unqualified</option>
        <option value="">All</option>
      </NativeSelect>
      <Card>
        <DataTable
          caption="Leads"
          rows={leads.data ?? []}
          isPending={leads.isPending}
          error={leads.error}
          onRetry={() => leads.refetch()}
          empty={<EmptyState icon={UserRoundPlus} title="No leads here" />}
          columns={[
            { key: 'name', header: 'Lead', cell: (l) => <span><span className="font-medium">{l.name}</span>{l.company ? <span className="text-muted-foreground"> · {l.company}</span> : null}</span> },
            { key: 'source', header: 'Source', cell: (l) => l.source ?? '—', className: 'hidden md:table-cell' },
            { key: 'value', header: 'Value', cell: (l) => (l.estimatedValue ? formatMoney(l.estimatedValue, l.currency) : '—'), className: 'hidden sm:table-cell text-right' },
            { key: 'status', header: 'Status', cell: (l) => <StatusBadge map={LEAD_STATUS} value={l.status} /> },
            {
              key: 'actions',
              header: <span className="sr-only">Actions</span>,
              cell: (l) =>
                l.status === 'CONVERTED' ? (
                  <Link href={`/clients/${l.convertedClientId}`} className="text-sm hover:underline">Open client</Link>
                ) : (
                  <span className="flex flex-wrap justify-end gap-2">
                    <NativeSelect aria-label={`Move ${l.name}`} value="" onChange={(e) => e.target.value && changeStatus(l, e.target.value)} className="h-8 w-auto text-xs">
                      <option value="">Move to…</option>
                      {LEAD_NEXT[l.status].map((s) => <option key={s} value={s}>{LEAD_STATUS[s][0]}</option>)}
                    </NativeSelect>
                    {l.status !== 'LOST' ? <Button size="sm" variant="outline" onClick={() => setConverting(l)}>Convert</Button> : null}
                  </span>
                ),
            },
          ]}
        />
      </Card>
      {creating ? <LeadDialog onClose={() => setCreating(false)} /> : null}
      {converting ? <ConvertDialog lead={converting} onClose={() => setConverting(null)} /> : null}
    </>
  );
}

// ─── pipeline ─────────────────────────────────────────────────────────────

function OpportunityDialog({ stages, onClose }) {
  const me = useMe();
  const clients = useClients();
  const open = stages.filter((s) => !s.isWon && !s.isLost && !s.archived);
  const form = useForm({ defaultValues: { name: '', clientId: '', stageId: open[0]?.id ?? '', value: '', currency: me.organization.baseCurrency ?? 'USD', expectedCloseDate: '' } });
  const create = useAction((v) => api.post('/opportunities', { name: v.name, stageId: v.stageId, value: v.value, currency: v.currency.toUpperCase(), ...(v.clientId ? { clientId: v.clientId } : {}), ...(v.expectedCloseDate ? { expectedCloseDate: v.expectedCloseDate } : {}) }, { idempotencyKey: newKey() }), { success: 'Opportunity added', onSuccess: onClose });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>New opportunity</DialogTitle><DialogDescription>A deal you expect to close.</DialogDescription></DialogHeader>
        <form onSubmit={form.handleSubmit((v) => create.mutate(v))} className="grid gap-4 sm:grid-cols-2">
          <FormField label="Name" required>{(a) => <Input required {...a} {...form.register('name')} />}</FormField>
          <FormField label="Client">{(a) => <NativeSelect {...a} {...form.register('clientId')}><option value="">No client yet</option>{(clients.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</NativeSelect>}</FormField>
          <FormField label="Stage">{(a) => <NativeSelect {...a} {...form.register('stageId')}>{open.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.defaultProbability}%)</option>)}</NativeSelect>}</FormField>
          <FormField label="Expected close">{(a) => <Input type="date" {...a} {...form.register('expectedCloseDate')} />}</FormField>
          <FormField label="Value" required>{(a) => <Input required inputMode="decimal" pattern="\d+(\.\d{1,2})?" {...a} {...form.register('value')} />}</FormField>
          <FormField label="Currency">{(a) => <Input maxLength={3} {...a} {...form.register('currency')} />}</FormField>
          <DialogFooter className="sm:col-span-2">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={create.isPending}>Add</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function PipelinePage() {
  const me = useMe();
  const stages = useStages();
  const [creating, setCreating] = useState(false);
  const today = todayIn(me.organization.timeZone);
  const quarterEnd = useMemo(() => {
    const d = new Date(`${today}T00:00:00Z`);
    const end = new Date(Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3 + 3, 0));
    return end.toISOString().slice(0, 10);
  }, [today]);
  const opps = useQuery({ queryKey: crmKeys.opportunities({ open: true }), queryFn: async () => (await api.get('/opportunities', { query: { open: 'true' } })).data });
  const summary = useQuery({ queryKey: crmKeys.pipeline({ from: today, to: quarterEnd }), queryFn: async () => (await api.get('/pipeline', { query: { from: today, to: quarterEnd } })).data });
  const move = useAction(({ id, stageId, lostReason }) => api.patch(`/opportunities/${id}`, { stageId, ...(lostReason ? { lostReason } : {}) }), { success: 'Moved' });
  if (stages.isPending || opps.isPending) return <Skeleton className="h-96" role="status" aria-label="Loading pipeline" />;
  if (stages.error || opps.error) return <ErrorState error={stages.error ?? opps.error} />;
  const openStages = stages.data.filter((s) => !s.isWon && !s.isLost && !s.archived);
  function moveTo(o, stageId) {
    const target = stages.data.find((s) => s.id === stageId);
    if (target.isLost) {
      const reason = window.prompt('Why was this lost?');
      if (!reason) return;
      move.mutate({ id: o.id, stageId, lostReason: reason });
    } else move.mutate({ id: o.id, stageId });
  }
  return (
    <>
      <PageHeader title="Pipeline" description="Open opportunities by stage." actions={<Button onClick={() => setCreating(true)}><Plus aria-hidden /> New opportunity</Button>} />
      {summary.data ? (
        <div className="mb-6 grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border bg-card p-4">
            <p className="text-sm text-muted-foreground">Pipeline value</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{formatMoney(summary.data.pipelineValue.value, summary.data.currency)}</p>
            <p className="mt-1 text-xs text-muted-foreground"><span className="font-medium">Measured</span> · all open opportunities in {summary.data.currency}{summary.data.unconvertedCurrencies.length ? ` (excluding ${summary.data.unconvertedCurrencies.join(', ')}: no exchange rate)` : ''}</p>
          </div>
          <div className="rounded-lg border bg-card p-4">
            <p className="text-sm text-muted-foreground">Weighted forecast to {formatDate(quarterEnd)}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{formatMoney(summary.data.weightedForecast.value, summary.data.currency)}</p>
            <p className="mt-1 text-xs text-muted-foreground"><span className="font-medium">Estimated</span> · value × probability for deals expected to close this quarter</p>
          </div>
        </div>
      ) : null}
      <div className="grid gap-4 overflow-x-auto pb-2 md:grid-cols-[repeat(4,minmax(14rem,1fr))]">
        {openStages.map((stage) => {
          const items = opps.data.filter((o) => o.stage?.id === stage.id);
          return (
            <section key={stage.id} aria-labelledby={`stage-${stage.id}`} className="grid content-start gap-2 rounded-lg bg-muted/60 p-3">
              <h2 id={`stage-${stage.id}`} className="text-sm font-semibold">{stage.name} <span className="font-normal text-muted-foreground">· {items.length} · {stage.defaultProbability}%</span></h2>
              {items.map((o) => (
                <article key={o.id} className="grid gap-1 rounded-md border bg-card p-3 text-sm">
                  <p className="font-medium">{o.name}</p>
                  <p className="text-muted-foreground">{o.client?.name ?? 'No client'}{o.expectedCloseDate ? ` · closes ${formatDate(o.expectedCloseDate)}` : ''}</p>
                  <p className="tabular-nums">{formatMoney(o.value, o.currency)} <span className="text-xs text-muted-foreground">({o.probability}%)</span></p>
                  <NativeSelect aria-label={`Move ${o.name}`} value="" onChange={(e) => e.target.value && moveTo(o, e.target.value)} className="h-8 text-xs">
                    <option value="">Move to…</option>
                    {stages.data.filter((s) => s.id !== stage.id && !s.archived).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </NativeSelect>
                </article>
              ))}
            </section>
          );
        })}
      </div>
      {creating ? <OpportunityDialog stages={stages.data} onClose={() => setCreating(false)} /> : null}
    </>
  );
}

// ─── quotes ───────────────────────────────────────────────────────────────

function NewQuoteDialog({ onClose }) {
  const router = useRouter();
  const clients = useClients();
  const form = useForm({ defaultValues: { clientId: '', title: '' } });
  const create = useAction((v) => api.post('/quotes', { clientId: v.clientId, title: v.title, items: [] }, { idempotencyKey: newKey() }), { success: 'Quote created', onSuccess: ({ data }) => router.push(`/quotes/${data.id}`) });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>New quote</DialogTitle><DialogDescription>Add lines on the next screen.</DialogDescription></DialogHeader>
        <form onSubmit={form.handleSubmit((v) => create.mutate(v))} className="grid gap-4">
          <FormField label="Client" required>{(a) => <NativeSelect required {...a} {...form.register('clientId')}><option value="">Choose…</option>{(clients.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</NativeSelect>}</FormField>
          <FormField label="Title" required>{(a) => <Input required {...a} {...form.register('title')} />}</FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={create.isPending}>Create</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function QuotesPage() {
  const [creating, setCreating] = useState(false);
  const quotes = useQuery({ queryKey: crmKeys.quotes({}), queryFn: async () => (await api.get('/quotes')).data });
  return (
    <>
      <PageHeader title="Quotes" description="Proposals with priced lines; revisions keep the history." actions={<Button onClick={() => setCreating(true)}><Plus aria-hidden /> New quote</Button>} />
      <Card>
        <DataTable
          caption="Quotes"
          rows={quotes.data ?? []}
          isPending={quotes.isPending}
          error={quotes.error}
          onRetry={() => quotes.refetch()}
          empty={<EmptyState icon={FileText} title="No quotes yet" />}
          columns={[
            { key: 'number', header: 'Quote', cell: (q) => <Link href={`/quotes/${q.id}`} className="font-medium hover:underline">{q.number} v{q.version}</Link> },
            { key: 'title', header: 'Title', cell: (q) => q.title },
            { key: 'client', header: 'Client', cell: (q) => q.client?.name, className: 'hidden md:table-cell' },
            { key: 'total', header: 'Total', cell: (q) => formatMoney(q.total, q.currency), className: 'text-right tabular-nums' },
            { key: 'status', header: 'Status', cell: (q) => <StatusBadge map={QUOTE_STATUS} value={q.status} /> },
          ]}
        />
      </Card>
      {creating ? <NewQuoteDialog onClose={() => setCreating(false)} /> : null}
    </>
  );
}

/** Line editor shared by quotes and invoices: description, quantity, unit price, tax rate (%). */
export function LineFields({ form, name = 'items' }) {
  const { fields, append, remove } = useFieldArray({ control: form.control, name });
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-sm font-medium">Lines</legend>
      {fields.map((field, i) => (
        <div key={field.id} className="grid grid-cols-2 gap-2 sm:grid-cols-[1fr_6rem_8rem_6rem_auto]">
          <Input aria-label={`Line ${i + 1} description`} required className="col-span-2 sm:col-span-1" {...form.register(`${name}.${i}.description`)} />
          <Input aria-label={`Line ${i + 1} quantity`} required inputMode="decimal" pattern="\d+(\.\d{1,4})?" {...form.register(`${name}.${i}.quantity`)} />
          <Input aria-label={`Line ${i + 1} unit price`} required inputMode="decimal" pattern="\d+(\.\d{1,4})?" {...form.register(`${name}.${i}.unitPrice`)} />
          <Input aria-label={`Line ${i + 1} tax %`} inputMode="decimal" pattern="\d+(\.\d{1,2})?" {...form.register(`${name}.${i}.taxPercent`)} />
          <Button type="button" size="icon" variant="ghost" aria-label={`Remove line ${i + 1}`} onClick={() => remove(i)}><Trash2 aria-hidden /></Button>
        </div>
      ))}
      <p className="text-xs text-muted-foreground">Description · Quantity · Unit price · Tax %</p>
      <Button type="button" size="sm" variant="outline" className="justify-self-start" onClick={() => append({ description: '', quantity: '1', unitPrice: '', taxPercent: '0' })}><Plus aria-hidden /> Add line</Button>
    </fieldset>
  );
}

/** Tax percent as typed ("18", "7.5") → the API's rate ("0.1800", "0.0750"), exactly (integer maths). */
export function percentToRate(percent) {
  const [whole = '0', frac = ''] = String(percent || '0').trim().split('.');
  const hundredths = Number(whole) * 100 + Number(frac.padEnd(2, '0').slice(0, 2));
  return `${Math.floor(hundredths / 10000)}.${String(hundredths % 10000).padStart(4, '0')}`;
}
export const rateToPercent = (rate) => String(Number((Number(rate) * 100).toFixed(2)));

export function TotalsTable({ doc, caption }) {
  return (
    <Table scrollLabel={caption}>
      <caption className="sr-only">{caption}</caption>
      <TableHeader>
        <tr>
          <TableHead>Description</TableHead>
          <TableHead className="text-right">Qty</TableHead>
          <TableHead className="text-right">Unit price</TableHead>
          <TableHead className="text-right">Tax</TableHead>
          <TableHead className="text-right">Amount</TableHead>
        </tr>
      </TableHeader>
      <TableBody>
        {doc.items.map((i) => (
          <TableRow key={i.id}>
            <TableCell>{i.description}</TableCell>
            <TableCell className="text-right tabular-nums">{Number(i.quantity)}</TableCell>
            <TableCell className="text-right tabular-nums">{formatMoney(i.unitPrice, doc.currency)}</TableCell>
            <TableCell className="text-right tabular-nums">{rateToPercent(i.taxRate)}%</TableCell>
            <TableCell className="text-right tabular-nums">{formatMoney(i.lineTotal, doc.currency)}</TableCell>
          </TableRow>
        ))}
        <TableRow><TableCell colSpan={4} className="text-right text-muted-foreground">Subtotal</TableCell><TableCell className="text-right tabular-nums">{formatMoney(doc.subtotal, doc.currency)}</TableCell></TableRow>
        <TableRow><TableCell colSpan={4} className="text-right text-muted-foreground">Tax</TableCell><TableCell className="text-right tabular-nums">{formatMoney(doc.taxTotal, doc.currency)}</TableCell></TableRow>
        <TableRow className="font-semibold"><TableCell colSpan={4} className="text-right">Total</TableCell><TableCell className="text-right tabular-nums">{formatMoney(doc.total, doc.currency)}</TableCell></TableRow>
      </TableBody>
    </Table>
  );
}

export function QuoteDetail({ quoteId }) {
  const router = useRouter();
  const quote = useQuery({ queryKey: crmKeys.quote(quoteId), queryFn: async () => (await api.get(`/quotes/${quoteId}`)).data });
  const form = useForm({ values: quote.data ? { title: quote.data.title, notes: quote.data.notes ?? '', validUntil: quote.data.validUntil ?? '', items: quote.data.items.map((i) => ({ description: i.description, quantity: String(Number(i.quantity)), unitPrice: i.unitPrice.replace(/\.?0+$/, ''), taxPercent: rateToPercent(i.taxRate) })) } : undefined });
  const save = useAction(
    (v) => api.patch(`/quotes/${quoteId}`, { title: v.title, notes: v.notes || null, validUntil: v.validUntil || null, items: v.items.map((i) => ({ description: i.description, quantity: i.quantity, unitPrice: i.unitPrice, taxRate: percentToRate(i.taxPercent) })) }),
    { success: 'Quote saved' },
  );
  const act = useAction((action) => api.post(`/quotes/${quoteId}/${action}`), {
    success: (_d, action) => ({ send: 'Marked as sent', accept: 'Marked as accepted', decline: 'Marked as declined', revise: 'New version created' })[action],
    onSuccess: ({ data }, action) => action === 'revise' && router.push(`/quotes/${data.id}`),
  });
  if (quote.isPending) return <Skeleton className="h-96" role="status" aria-label="Loading quote" />;
  if (quote.error) return <ErrorState error={quote.error} />;
  const q = quote.data;
  return (
    <>
      <PageHeader
        title={`${q.number} v${q.version} · ${q.title}`}
        description={<span className="inline-flex items-center gap-2">{q.client?.name} · <StatusBadge map={QUOTE_STATUS} value={q.status} /></span>}
        actions={
          <span className="flex flex-wrap gap-2">
            {q.status === 'DRAFT' ? <Button onClick={() => act.mutate('send')} disabled={act.isPending}>Mark sent</Button> : null}
            {q.status === 'SENT' ? <><Button onClick={() => act.mutate('accept')}>Accepted</Button><Button variant="outline" onClick={() => act.mutate('decline')}>Declined</Button></> : null}
            {['SENT', 'DECLINED'].includes(q.status) ? <Button variant="outline" onClick={() => act.mutate('revise')}>Revise</Button> : null}
          </span>
        }
      />
      {q.status === 'DRAFT' ? (
        <Card>
          <CardContent className="pt-6">
            <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="grid gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField label="Title" required>{(a) => <Input required {...a} {...form.register('title')} />}</FormField>
                <FormField label="Valid until">{(a) => <Input type="date" {...a} {...form.register('validUntil')} />}</FormField>
              </div>
              <LineFields form={form} />
              <FormField label="Notes">{(a) => <Textarea rows={3} {...a} {...form.register('notes')} />}</FormField>
              <Button type="submit" className="justify-self-start" disabled={save.isPending}>Save</Button>
            </form>
          </CardContent>
        </Card>
      ) : null}
      <Card className="mt-6">
        <CardHeader><CardTitle>Totals</CardTitle><CardDescription>Each line is rounded to the currency, then summed; amounts are exact.</CardDescription></CardHeader>
        <CardContent><TotalsTable doc={q} caption={`Lines of ${q.number}`} /></CardContent>
      </Card>
    </>
  );
}
