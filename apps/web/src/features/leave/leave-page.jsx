'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useForm, useWatch } from 'react-hook-form';
import { Plane, Plus } from 'lucide-react';
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
import { addDays, formatDate, todayIn } from '@/lib/format';
import { cn } from '@/lib/utils';
import { newKey, useAction } from '@/features/crm/queries';

const keys = { all: ['leave'], balances: (p) => ['leave', 'balances', p], requests: (p) => ['leave', 'requests', p], types: ['leave', 'types'] };
const STATUS = { PENDING: ['Pending', 'info'], APPROVED: ['Approved', 'success'], REJECTED: ['Rejected', 'danger'], CANCELLED: ['Cancelled', 'neutral'] };
const HALF = { FULL: 'Full day', AM: 'Morning', PM: 'Afternoon' };
const fmtDays = (d) => `${d} ${Math.abs(d) === 1 ? 'day' : 'days'}`;

function describeDates(r) {
  const start = `${formatDate(r.startDate)}${r.startHalf !== 'FULL' ? ` (${HALF[r.startHalf].toLowerCase()})` : ''}`;
  if (r.startDate === r.endDate) return start;
  return `${start} – ${formatDate(r.endDate)}${r.endHalf === 'AM' ? ' (morning)' : ''}`;
}

export function Balances({ employeeId }) {
  const balances = useQuery({ queryKey: keys.balances({ employeeId }), queryFn: async () => (await api.get('/leave/balances', { query: employeeId ? { employeeId } : undefined })).data });
  if (balances.isPending) return <Skeleton className="h-28" />;
  if (balances.error) return <ErrorState error={balances.error} />;
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {balances.data.map((b) => (
        <div key={b.leaveType.id} className="rounded-lg border bg-card p-4">
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <span aria-hidden className="size-2.5 rounded-full" style={{ backgroundColor: b.leaveType.color ?? 'var(--muted-foreground)' }} />
            {b.leaveType.name}
          </p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">{b.available}<span className="text-sm font-normal text-muted-foreground"> available</span></p>
          <p className="mt-1 text-xs text-muted-foreground">
            {b.balance} balance · {b.used} used · {b.pending} pending{b.policy?.allowNegative ? ' · may go negative' : ''}
          </p>
        </div>
      ))}
    </div>
  );
}

function RequestDialog({ onClose }) {
  const me = useMe();
  const types = useQuery({ queryKey: keys.types, queryFn: async () => (await api.get('/leave/types')).data });
  const today = todayIn(me.organization.timeZone);
  const form = useForm({ defaultValues: { leaveTypeId: '', startDate: addDays(today, 1), endDate: addDays(today, 1), startHalf: 'FULL', endHalf: 'FULL', reason: '' } });
  const values = useWatch({ control: form.control });
  const [preview, setPreview] = useState(null);
  const typeId = values.leaveTypeId || types.data?.find((t) => !t.archived)?.id;
  useEffect(() => {
    if (!typeId || !values.startDate || !values.endDate || values.endDate < values.startDate) return undefined;
    let live = true;
    const body = { leaveTypeId: typeId, startDate: values.startDate, endDate: values.endDate, startHalf: values.startHalf, endHalf: values.startDate === values.endDate ? 'FULL' : values.endHalf };
    api.post('/leave/requests/preview', body).then(({ data }) => live && setPreview({ ok: true, ...data }), (e) => live && setPreview({ ok: false, message: e.details?.[0]?.message ?? e.message }));
    return () => {
      live = false;
    };
  }, [typeId, values.startDate, values.endDate, values.startHalf, values.endHalf]);
  const submit = useAction(
    (v) => api.post('/leave/requests', { leaveTypeId: typeId, startDate: v.startDate, endDate: v.endDate, startHalf: v.startHalf, endHalf: v.startDate === v.endDate ? 'FULL' : v.endHalf, ...(v.reason ? { reason: v.reason } : {}) }, { idempotencyKey: newKey() }),
    { success: 'Leave requested', keys: [keys.all], onSuccess: onClose },
  );
  const type = types.data?.find((t) => t.id === typeId);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Request leave</DialogTitle><DialogDescription>Weekends, holidays and days outside your schedule are not counted.</DialogDescription></DialogHeader>
        <form onSubmit={form.handleSubmit((v) => submit.mutate(v))} className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2"><FormField label="Type">{(a) => <NativeSelect {...a} {...form.register('leaveTypeId')}>{(types.data ?? []).filter((t) => !t.archived).map((t) => <option key={t.id} value={t.id}>{t.name}{t.isPaid ? '' : ' (unpaid)'}</option>)}</NativeSelect>}</FormField></div>
          <FormField label="From" required>{(a) => <Input type="date" required {...a} {...form.register('startDate')} />}</FormField>
          <FormField label="To" required>{(a) => <Input type="date" required {...a} {...form.register('endDate')} />}</FormField>
          {type?.allowsHalfDay ? (
            <>
              <FormField label={values.startDate === values.endDate ? 'Which part' : 'First day'}>{(a) => <NativeSelect {...a} {...form.register('startHalf')}><option value="FULL">Full day</option>{values.startDate === values.endDate ? <option value="AM">Morning only</option> : null}<option value="PM">{values.startDate === values.endDate ? 'Afternoon only' : 'From the afternoon'}</option></NativeSelect>}</FormField>
              {values.startDate !== values.endDate ? <FormField label="Last day">{(a) => <NativeSelect {...a} {...form.register('endHalf')}><option value="FULL">Full day</option><option value="AM">Until midday</option></NativeSelect>}</FormField> : <div />}
            </>
          ) : null}
          <div className="sm:col-span-2"><FormField label="Note for your approver">{(a) => <Textarea rows={2} maxLength={1000} {...a} {...form.register('reason')} />}</FormField></div>
          <p className={cn('rounded-md border p-3 text-sm sm:col-span-2', preview && !preview.ok && 'border-danger text-danger')} role="status" aria-live="polite">
            {!preview ? 'Choose dates to see how many days this uses.' : preview.ok ? `${fmtDays(preview.days)} · ${preview.available} available now · ${preview.afterRequest} after this request${preview.afterRequest < 0 && !preview.allowNegative ? ' — not enough balance' : ''}` : preview.message}
          </p>
          <DialogFooter className="sm:col-span-2">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={submit.isPending || !preview?.ok || preview.days <= 0}>Request</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RequestsTable({ view, employeeId, caption }) {
  const query = { view, ...(employeeId ? { employeeId } : {}) };
  const requests = useQuery({ queryKey: keys.requests(query), queryFn: async () => (await api.get('/leave/requests', { query })).data });
  const decide = useAction(({ id, decision, comment }) => api.post(`/leave/requests/${id}/${decision}`, comment ? { comment } : {}, { idempotencyKey: newKey() }), { success: (_d, v) => (v.decision === 'approve' ? 'Approved' : 'Rejected'), keys: [keys.all] });
  const cancel = useAction((id) => api.post(`/leave/requests/${id}/cancel`, {}, { idempotencyKey: newKey() }), { success: 'Cancelled', keys: [keys.all] });
  return (
    <DataTable
      caption={caption}
      rows={requests.data ?? []}
      isPending={requests.isPending}
      error={requests.error}
      onRetry={() => requests.refetch()}
      empty={<EmptyState icon={Plane} title={view === 'approvals' ? 'Nothing waiting for you' : 'No leave requests'} />}
      columns={[
        ...(view !== 'mine' ? [{ key: 'who', header: 'Employee', cell: (r) => <span className="font-medium">{r.employee.name}</span> }] : []),
        { key: 'type', header: 'Type', cell: (r) => r.leaveType.name },
        { key: 'dates', header: 'Dates', cell: (r) => describeDates(r) },
        { key: 'days', header: 'Days', cell: (r) => r.days, className: 'text-right tabular-nums' },
        { key: 'status', header: 'Status', cell: (r) => <span className="grid gap-0.5"><Badge tone={STATUS[r.status][1]}>{STATUS[r.status][0]}</Badge>{r.step ? <span className="text-xs text-muted-foreground">Step {r.step.index + 1}/{r.step.of}: {r.step.approvers.map((a) => a.name).join(', ')}</span> : null}</span> },
        {
          key: 'actions',
          header: <span className="sr-only">Actions</span>,
          cell: (r) => (
            <span className="flex flex-wrap justify-end gap-2">
              {r.canDecide ? (
                <>
                  <Button size="sm" onClick={() => decide.mutate({ id: r.id, decision: 'approve' })}>Approve</Button>
                  <Button size="sm" variant="outline" onClick={() => { const c = window.prompt('Why reject this request?'); if (c) decide.mutate({ id: r.id, decision: 'reject', comment: c }); }}>Reject</Button>
                </>
              ) : null}
              {view === 'mine' && ['PENDING', 'APPROVED'].includes(r.status) ? <Button size="sm" variant="ghost" onClick={() => window.confirm('Cancel this leave?') && cancel.mutate(r.id)}>Cancel</Button> : null}
            </span>
          ),
        },
      ]}
    />
  );
}

/** Profile → Time Off. */
export function EmployeeLeave({ employeeId, self }) {
  return (
    <div className="grid gap-6">
      <Balances employeeId={self ? undefined : employeeId} />
      <Card><RequestsTable view={self ? 'mine' : 'team'} employeeId={self ? undefined : employeeId} caption="Leave requests" /></Card>
    </div>
  );
}

export function LeavePage() {
  const router = useRouter();
  const params = useSearchParams();
  const canApprove = useCan('leave.approve');
  const me = useMe();
  const seesTeam = (me.permissions.find((p) => p.key === 'leave.read')?.scopes ?? []).some((s) => s !== 'self');
  const view = params.get('view') ?? 'mine';
  const [requesting, setRequesting] = useState(false);
  const views = [['mine', 'My leave'], ...(canApprove ? [['approvals', 'To approve']] : []), ...(seesTeam ? [['team', 'Team']] : [])];
  return (
    <>
      <PageHeader title="Time off" description="Balances come from a ledger of accruals, usage and adjustments." actions={<Button onClick={() => setRequesting(true)}><Plus aria-hidden /> Request leave</Button>} />
      <div role="tablist" aria-label="Leave views" className="mb-6 flex gap-1 border-b">
        {views.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={view === id} onClick={() => router.replace(`/leave?view=${id}`)} className={cn('h-10 border-b-2 px-3 text-sm', view === id ? 'border-primary font-medium text-primary' : 'border-transparent text-muted-foreground hover:text-foreground')}>{label}</button>
        ))}
      </div>
      {view === 'mine' ? (
        <div className="grid gap-6">
          <Balances />
          <Card><RequestsTable view="mine" caption="My leave requests" /></Card>
        </div>
      ) : (
        <Card>
          <CardHeader><CardTitle>{view === 'approvals' ? 'Waiting for your decision' : 'Leave in your team'}</CardTitle>{view === 'team' ? <CardDescription>Approved and pending leave also appears in the calendar.</CardDescription> : null}</CardHeader>
          <CardContent><RequestsTable view={view} caption={view === 'approvals' ? 'Leave to approve' : 'Team leave'} /></CardContent>
        </Card>
      )}
      {requesting ? <RequestDialog onClose={() => setRequesting(false)} /> : null}
    </>
  );
}
