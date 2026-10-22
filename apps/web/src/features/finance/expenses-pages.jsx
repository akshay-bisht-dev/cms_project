'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useForm, useWatch } from 'react-hook-form';
import { Paperclip, Plus, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, NativeSelect } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FormField } from '@/components/common/form-field';
import { PageHeader } from '@/components/common/page-header';
import { EmptyState, ErrorState } from '@/components/common/states';
import { DataTable } from '@/components/data-tables/data-table';
import { useEmployees } from '@/features/employees/queries';
import { useProjects } from '@/features/projects/queries';
import { useCan, useMe } from '@/features/session/session-provider';
import { api } from '@/lib/api';
import { formatDate, formatMoney, todayIn } from '@/lib/format';
import { cn } from '@/lib/utils';
import { EXPENSE_STATUS } from '@/features/crm/labels';
import { StatusBadge } from '@/features/crm/status-badge';
import { useAction, useClients } from '@/features/crm/queries';

const keys = { all: ['finance', 'expenses'], list: (p) => ['finance', 'expenses', p], categories: ['finance', 'categories'] };

/** Uploads a receipt straight to private storage with a signed URL, then confirms it. */
async function uploadReceipt(file) {
  const { data } = await api.post('/expenses/receipts', { fileName: file.name, contentType: file.type, sizeBytes: file.size });
  const put = await fetch(data.upload.url, { method: 'PUT', headers: data.upload.headers, body: file });
  if (!put.ok) throw new Error('The receipt upload failed');
  await api.post(`/expenses/receipts/${data.fileId}/confirm`);
  return data.fileId;
}

function ExpenseDialog({ onClose }) {
  const me = useMe();
  const categories = useQuery({ queryKey: keys.categories, queryFn: async () => (await api.get('/expense-categories')).data });
  const projects = useProjects({ mine: 'true' });
  const form = useForm({ defaultValues: { description: '', amount: '', currency: me.organization.baseCurrency ?? 'USD', incurredOn: todayIn(me.organization.timeZone), categoryId: '', projectId: '', isBillable: false, submit: true } });
  const [file, setFile] = useState(null);
  const save = useAction(
    async (v) => {
      const receiptFileId = file ? await uploadReceipt(file) : undefined;
      const { data } = await api.post('/expenses', {
        description: v.description,
        amount: v.amount,
        currency: v.currency.toUpperCase(),
        incurredOn: v.incurredOn,
        isBillable: v.isBillable,
        ...(v.categoryId ? { categoryId: v.categoryId } : {}),
        ...(v.projectId ? { projectId: v.projectId } : {}),
        ...(receiptFileId ? { receiptFileId } : {}),
      });
      if (v.submit) await api.post(`/expenses/${data.id}/submit`);
    },
    { success: (_d, v) => (v.submit ? 'Expense submitted for approval' : 'Expense saved as draft'), keys: [keys.all], onSuccess: onClose },
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader><DialogTitle>New expense</DialogTitle><DialogDescription>Receipts are stored privately; only you, approvers and finance can open them.</DialogDescription></DialogHeader>
        <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2"><FormField label="What for" required>{(a) => <Input required maxLength={500} {...a} {...form.register('description')} />}</FormField></div>
          <div className="grid grid-cols-[1fr_6rem] gap-2">
            <FormField label="Amount" required>{(a) => <Input required inputMode="decimal" pattern="\d+(\.\d{1,2})?" {...a} {...form.register('amount')} />}</FormField>
            <FormField label="Currency">{(a) => <Input maxLength={3} {...a} {...form.register('currency')} />}</FormField>
          </div>
          <FormField label="Date" required>{(a) => <Input type="date" required {...a} {...form.register('incurredOn')} />}</FormField>
          <FormField label="Category">{(a) => <NativeSelect {...a} {...form.register('categoryId')}><option value="">None</option>{(categories.data ?? []).filter((c) => !c.archived).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</NativeSelect>}</FormField>
          <FormField label="Project">{(a) => <NativeSelect {...a} {...form.register('projectId')}><option value="">None</option>{(projects.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}</NativeSelect>}</FormField>
          <FormField label="Receipt" hint="PDF or image, up to 10 MB">{(a) => <Input type="file" accept="application/pdf,image/png,image/jpeg,image/webp" {...a} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />}</FormField>
          <div className="grid content-end gap-2 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" className="size-4 accent-[var(--primary)]" {...form.register('isBillable')} /> Bill to the client</label>
            <label className="flex items-center gap-2"><input type="checkbox" className="size-4 accent-[var(--primary)]" {...form.register('submit')} /> Submit for approval now</label>
          </div>
          <DialogFooter className="sm:col-span-2">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={save.isPending}>Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

async function openReceipt(id) {
  try {
    const { data } = await api.get(`/expenses/${id}/receipt`);
    window.open(data.url, '_blank', 'noopener');
  } catch (error) {
    toast.error(error.message);
  }
}

export function ExpensesPage() {
  const canApprove = useCan('finance.expenses.approve');
  const canAll = useCan('finance.invoices.manage');
  const canReimburse = useCan('finance.payments.record');
  const [view, setView] = useState('mine');
  const [creating, setCreating] = useState(false);
  const expenses = useQuery({ queryKey: keys.list({ view }), queryFn: async () => (await api.get('/expenses', { query: { view } })).data });
  const submit = useAction((id) => api.post(`/expenses/${id}/submit`), { success: 'Submitted', keys: [keys.all] });
  const decide = useAction(({ id, decision, comment }) => api.post(`/expenses/${id}/decide`, { decision, ...(comment ? { comment } : {}) }), { success: (_d, v) => (v.decision === 'APPROVED' ? 'Approved' : 'Rejected'), keys: [keys.all] });
  const reimburse = useAction((id) => api.post(`/expenses/${id}/reimburse`), { success: 'Marked reimbursed', keys: [keys.all] });
  const views = [['mine', 'My expenses'], ...(canApprove ? [['approvals', 'To approve']] : []), ...(canAll ? [['all', 'All']] : [])];
  return (
    <>
      <PageHeader title="Expenses" description="Spend to be reimbursed and, when billable, invoiced to the client." actions={<Button onClick={() => setCreating(true)}><Plus aria-hidden /> New expense</Button>} />
      <div role="tablist" aria-label="Expense views" className="mb-4 flex gap-1 border-b">
        {views.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={view === id} onClick={() => setView(id)} className={cn('h-10 border-b-2 px-3 text-sm', view === id ? 'border-primary font-medium text-primary' : 'border-transparent text-muted-foreground hover:text-foreground')}>{label}</button>
        ))}
      </div>
      <Card>
        <DataTable
          caption="Expenses"
          rows={expenses.data ?? []}
          isPending={expenses.isPending}
          error={expenses.error}
          onRetry={() => expenses.refetch()}
          empty={<EmptyState icon={Wallet} title={view === 'approvals' ? 'Nothing waiting for you' : 'No expenses'} />}
          columns={[
            { key: 'date', header: 'Date', cell: (e) => formatDate(e.incurredOn) },
            { key: 'description', header: 'Expense', cell: (e) => <span>{e.description}{view !== 'mine' && e.employee ? <span className="text-muted-foreground"> · {e.employee.name}</span> : null}{e.project ? <span className="text-muted-foreground"> · {e.project.code}</span> : null}</span> },
            { key: 'amount', header: 'Amount', cell: (e) => formatMoney(e.amount, e.currency), className: 'text-right tabular-nums' },
            { key: 'status', header: 'Status', cell: (e) => <span className="inline-flex gap-1"><StatusBadge map={EXPENSE_STATUS} value={e.status} />{e.invoiced ? <StatusBadge map={{ X: ['Invoiced', 'info'] }} value="X" /> : null}</span> },
            {
              key: 'actions',
              header: <span className="sr-only">Actions</span>,
              cell: (e) => (
                <span className="flex flex-wrap justify-end gap-2">
                  {e.hasReceipt ? <Button size="sm" variant="ghost" onClick={() => openReceipt(e.id)}><Paperclip aria-hidden /> Receipt</Button> : null}
                  {e.own && ['DRAFT', 'REJECTED'].includes(e.status) ? <Button size="sm" variant="outline" onClick={() => submit.mutate(e.id)}>Submit</Button> : null}
                  {view === 'approvals' ? (
                    <>
                      <Button size="sm" onClick={() => decide.mutate({ id: e.id, decision: 'APPROVED' })}>Approve</Button>
                      <Button size="sm" variant="outline" onClick={() => { const c = window.prompt('Why reject this expense?'); if (c) decide.mutate({ id: e.id, decision: 'REJECTED', comment: c }); }}>Reject</Button>
                    </>
                  ) : null}
                  {view === 'all' && e.status === 'APPROVED' && canReimburse ? <Button size="sm" variant="outline" onClick={() => reimburse.mutate(e.id)}>Reimbursed</Button> : null}
                </span>
              ),
            },
          ]}
        />
      </Card>
      {creating ? <ExpenseDialog onClose={() => setCreating(false)} /> : null}
    </>
  );
}

export function FinanceSettings() {
  const me = useMe();
  const canCost = useCan('finance.cost.read');
  const rates = useQuery({ queryKey: ['finance', 'rates'], queryFn: async () => (await api.get('/billing-rates')).data });
  const fx = useQuery({ queryKey: ['finance', 'fx'], queryFn: async () => (await api.get('/exchange-rates')).data });
  const categories = useQuery({ queryKey: keys.categories, queryFn: async () => (await api.get('/expense-categories')).data });
  const people = useEmployees({ status: 'ACTIVE', limit: 100, sort: 'name' });
  const projects = useProjects();
  const clients = useClients();
  const today = todayIn(me.organization.timeZone);
  const rateForm = useForm({ defaultValues: { kind: 'BILL', targetType: 'ORG', targetId: '', projectId: '', amount: '', currency: me.organization.baseCurrency ?? 'USD', effectiveFrom: today } });
  const kind = useWatch({ control: rateForm.control, name: 'kind' });
  const targetType = useWatch({ control: rateForm.control, name: 'targetType' });
  const addRate = useAction((v) => api.post('/billing-rates', { kind: v.kind, targetType: v.targetType, amount: v.amount, currency: v.currency.toUpperCase(), effectiveFrom: v.effectiveFrom, ...(v.targetId ? { targetId: v.targetId } : {}), ...(v.projectId ? { projectId: v.projectId } : {}) }), { success: 'Rate added', keys: [['finance']] });
  const endRate = useAction(({ id, effectiveTo }) => api.post(`/billing-rates/${id}/end`, { effectiveTo }), { success: 'Rate ended', keys: [['finance']] });
  const fxForm = useForm({ defaultValues: { currency: '', rateToBase: '', effectiveFrom: today } });
  const addFx = useAction((v) => api.post('/exchange-rates', { ...v, currency: v.currency.toUpperCase() }), { success: 'Exchange rate added', keys: [['finance']], onSuccess: () => fxForm.reset({ currency: '', rateToBase: '', effectiveFrom: today }) });
  const catForm = useForm({ defaultValues: { name: '' } });
  const addCat = useAction((v) => api.post('/expense-categories', v), { success: 'Category added', keys: [['finance']], onSuccess: () => catForm.reset() });
  const targets = targetType === 'CLIENT' ? (clients.data ?? []).map((c) => [c.id, c.name]) : targetType === 'PROJECT' ? (projects.data ?? []).map((p) => [p.id, `${p.code} · ${p.name}`]) : (people.data?.data ?? []).map((p) => [p.employeeId, p.name]);
  return (
    <>
      <PageHeader title="Finance" description={`Rates, currencies and expense categories. Base currency: ${me.organization.baseCurrency}.`} />
      <div className="grid gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Hourly rates</CardTitle>
            <CardDescription>Billing precedence: person on a project › project › client › person › organization. Rates are never edited; end one and add the next.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <form onSubmit={rateForm.handleSubmit((v) => addRate.mutate(v))} className="grid gap-3 sm:grid-cols-4 lg:grid-cols-8 lg:items-end">
              <FormField label="Kind">{(a) => <NativeSelect {...a} {...rateForm.register('kind')}><option value="BILL">Billing</option>{canCost ? <option value="COST">Cost</option> : null}</NativeSelect>}</FormField>
              <FormField label="Applies to">{(a) => <NativeSelect {...a} {...rateForm.register('targetType', { onChange: () => rateForm.setValue('targetId', '') })}>{(kind === 'COST' ? ['ORG', 'MEMBER'] : ['ORG', 'MEMBER', 'CLIENT', 'PROJECT', 'PROJECT_MEMBER']).map((t) => <option key={t} value={t}>{{ ORG: 'Organization', MEMBER: 'Person', CLIENT: 'Client', PROJECT: 'Project', PROJECT_MEMBER: 'Person on a project' }[t]}</option>)}</NativeSelect>}</FormField>
              {targetType !== 'ORG' ? <FormField label="Which">{(a) => <NativeSelect required {...a} {...rateForm.register('targetId')}><option value="">Choose…</option>{targets.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</NativeSelect>}</FormField> : null}
              {targetType === 'PROJECT_MEMBER' ? <FormField label="Project">{(a) => <NativeSelect required {...a} {...rateForm.register('projectId')}><option value="">Choose…</option>{(projects.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.code}</option>)}</NativeSelect>}</FormField> : null}
              <FormField label="Per hour" required>{(a) => <Input required inputMode="decimal" pattern="\d+(\.\d{1,2})?" {...a} {...rateForm.register('amount')} />}</FormField>
              <FormField label="Currency">{(a) => <Input maxLength={3} {...a} {...rateForm.register('currency')} />}</FormField>
              <FormField label="From" required>{(a) => <Input type="date" required {...a} {...rateForm.register('effectiveFrom')} />}</FormField>
              <Button type="submit" disabled={addRate.isPending}>Add rate</Button>
            </form>
            {rates.error ? <ErrorState error={rates.error} /> : (
              <ul className="divide-y text-sm">
                {(rates.data ?? []).map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-3 py-2">
                    <span className="flex-1">{r.kind === 'COST' ? 'Cost' : 'Billing'} · {r.target} · {formatMoney(r.amount, r.currency)}/h · from {formatDate(r.effectiveFrom)}{r.effectiveTo ? ` to ${formatDate(r.effectiveTo)}` : ''}</span>
                    {!r.effectiveTo ? <Button size="sm" variant="ghost" onClick={() => { const d = window.prompt('Last day of this rate (YYYY-MM-DD)', today); if (d) endRate.mutate({ id: r.id, effectiveTo: d }); }}>End</Button> : null}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader><CardTitle>Exchange rates</CardTitle><CardDescription>1 unit of the currency = rate × {me.organization.baseCurrency}. Used for reports; nothing is fetched automatically.</CardDescription></CardHeader>
            <CardContent className="grid gap-4">
              <form onSubmit={fxForm.handleSubmit((v) => addFx.mutate(v))} className="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:items-end">
                <FormField label="Currency" required>{(a) => <Input required maxLength={3} {...a} {...fxForm.register('currency')} />}</FormField>
                <FormField label="Rate" required>{(a) => <Input required inputMode="decimal" {...a} {...fxForm.register('rateToBase')} />}</FormField>
                <FormField label="From" required>{(a) => <Input type="date" required {...a} {...fxForm.register('effectiveFrom')} />}</FormField>
                <Button type="submit" disabled={addFx.isPending}>Add</Button>
              </form>
              <ul className="divide-y text-sm">{(fx.data ?? []).map((r) => <li key={r.id} className="py-2">{r.currency} = {Number(r.rateToBase)} {me.organization.baseCurrency} from {formatDate(r.effectiveFrom)}</li>)}</ul>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Expense categories</CardTitle></CardHeader>
            <CardContent className="grid gap-4">
              <form onSubmit={catForm.handleSubmit((v) => addCat.mutate(v))} className="flex gap-3">
                <Input aria-label="Category name" required maxLength={80} {...catForm.register('name')} />
                <Button type="submit" disabled={addCat.isPending}>Add</Button>
              </form>
              <ul className="flex flex-wrap gap-2 text-sm">{(categories.data ?? []).map((c) => <li key={c.id} className="rounded-full bg-muted px-3 py-1">{c.name}</li>)}</ul>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
