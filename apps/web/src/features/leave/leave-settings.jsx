'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, NativeSelect } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FormField } from '@/components/common/form-field';
import { PageHeader } from '@/components/common/page-header';
import { ErrorState } from '@/components/common/states';
import { useDepartments, useEmployees, useTeams } from '@/features/employees/queries';
import { api } from '@/lib/api';
import { useAction } from '@/features/crm/queries';

const RULES = { MANAGER: 'Reporting manager', TEAM_LEAD: 'Team lead', HR: 'HR (anyone who approves leave organization-wide)' };
const ACCRUAL = { NONE: 'No accrual', MONTHLY: 'Monthly', ANNUAL: 'Yearly (1 January)' };
const keys = [['leave']];

function PolicyDialog({ policy, types, onClose }) {
  const form = useForm({
    defaultValues: {
      leaveTypeId: policy?.leaveType.id ?? types[0]?.id ?? '',
      name: policy?.name ?? '',
      accrual: policy?.accrual ?? 'ANNUAL',
      accrualDays: String(policy?.accrualDays ?? 0),
      capDays: policy?.capDays === null || policy?.capDays === undefined ? '' : String(policy.capDays),
      carryOverMaxDays: policy?.carryOverMaxDays === null || policy?.carryOverMaxDays === undefined ? '' : String(policy.carryOverMaxDays),
      allowNegative: policy?.allowNegative ?? false,
      step1: policy?.approvalChain[0] ?? 'MANAGER',
      step2: policy?.approvalChain[1] ?? '',
    },
  });
  const save = useAction(
    (v) => {
      const body = {
        name: v.name,
        accrual: v.accrual,
        accrualDays: v.accrualDays || '0',
        capDays: v.capDays || null,
        carryOverMaxDays: v.carryOverMaxDays || null,
        allowNegative: v.allowNegative,
        approvalChain: [v.step1, v.step2].filter(Boolean),
      };
      return policy ? api.patch(`/leave/policies/${policy.id}`, body) : api.post('/leave/policies', { ...body, leaveTypeId: v.leaveTypeId });
    },
    { success: 'Policy saved', keys, onSuccess: onClose },
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader><DialogTitle>{policy ? `Edit ${policy.name}` : 'New leave policy'}</DialogTitle><DialogDescription>Changes apply to future accruals and requests; past ledger entries stay as they are.</DialogDescription></DialogHeader>
        <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="grid gap-4 sm:grid-cols-2">
          {!policy ? <FormField label="Leave type">{(a) => <NativeSelect {...a} {...form.register('leaveTypeId')}>{types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</NativeSelect>}</FormField> : null}
          <FormField label="Name" required>{(a) => <Input required {...a} {...form.register('name')} />}</FormField>
          <FormField label="Accrual">{(a) => <NativeSelect {...a} {...form.register('accrual')}>{Object.entries(ACCRUAL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</NativeSelect>}</FormField>
          <FormField label="Days per accrual" hint="Whole or half days">{(a) => <Input inputMode="decimal" pattern="\d{1,3}(\.(0|5))?" {...a} {...form.register('accrualDays')} />}</FormField>
          <FormField label="Balance cap (days)" hint="Empty = no cap">{(a) => <Input inputMode="decimal" pattern="\d{1,3}(\.(0|5))?" {...a} {...form.register('capDays')} />}</FormField>
          <FormField label="Carry over at most (days)" hint="Empty = nothing carries over">{(a) => <Input inputMode="decimal" pattern="\d{1,3}(\.(0|5))?" {...a} {...form.register('carryOverMaxDays')} />}</FormField>
          <FormField label="First approver">{(a) => <NativeSelect {...a} {...form.register('step1')}>{Object.entries(RULES).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</NativeSelect>}</FormField>
          <FormField label="Then">{(a) => <NativeSelect {...a} {...form.register('step2')}><option value="">Nobody else</option>{Object.entries(RULES).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</NativeSelect>}</FormField>
          <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" className="size-4 accent-[var(--primary)]" {...form.register('allowNegative')} /> Allow the balance to go negative</label>
          <DialogFooter className="sm:col-span-2">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={save.isPending}>Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AssignDialog({ policy, onClose }) {
  const departments = useDepartments();
  const teams = useTeams();
  const people = useEmployees({ status: 'ACTIVE', limit: 100, sort: 'name' });
  const [targets, setTargets] = useState(policy.assignments.map((a) => ({ type: a.targetType, id: a.targetId })));
  const options = [
    ...(departments.data ?? []).map((d) => ({ type: 'DEPARTMENT', id: d.id, label: `Department: ${d.name}` })),
    ...(teams.data ?? []).map((t) => ({ type: 'TEAM', id: t.id, label: `Team: ${t.name}` })),
    ...(people.data?.data ?? []).map((p) => ({ type: 'MEMBER', id: p.employeeId, label: p.name })),
  ];
  const save = useAction(() => api.put(`/leave/policies/${policy.id}/assignments`, { targets }), { success: 'Assignments saved', keys, onSuccess: onClose });
  const has = (o) => targets.some((t) => t.type === o.type && t.id === o.id);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Who {policy.name} applies to</DialogTitle><DialogDescription>A person’s own policy wins over their team’s, which wins over their department’s, which wins over the default.</DialogDescription></DialogHeader>
        <fieldset className="grid gap-2">
          <legend className="sr-only">Targets</legend>
          {options.map((o) => (
            <label key={`${o.type}:${o.id}`} className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={has(o)} onChange={(e) => setTargets((ts) => (e.target.checked ? [...ts, { type: o.type, id: o.id }] : ts.filter((t) => !(t.type === o.type && t.id === o.id))))} />
              {o.label}
            </label>
          ))}
        </fieldset>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={save.isPending} onClick={() => save.mutate()}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function LeaveSettings() {
  const types = useQuery({ queryKey: ['leave', 'types'], queryFn: async () => (await api.get('/leave/types')).data });
  const policies = useQuery({ queryKey: ['leave', 'policies'], queryFn: async () => (await api.get('/leave/policies')).data });
  const [editing, setEditing] = useState(null);
  const [assigning, setAssigning] = useState(null);
  const typeForm = useForm({ defaultValues: { code: '', name: '', isPaid: true } });
  const addType = useAction((v) => api.post('/leave/types', { code: v.code.toUpperCase(), name: v.name, isPaid: v.isPaid }), { success: 'Leave type added', keys, onSuccess: () => typeForm.reset() });
  if (types.isPending || policies.isPending) return <Skeleton className="h-96" role="status" aria-label="Loading leave settings" />;
  if (types.error || policies.error) return <ErrorState error={types.error ?? policies.error} />;
  return (
    <>
      <PageHeader title="Leave" description="Leave types, how they accrue and who approves them." actions={<Button onClick={() => setEditing('new')}>New policy</Button>} />
      <div className="grid gap-6">
        <Card>
          <CardHeader><CardTitle>Policies</CardTitle><CardDescription>Each type has a default policy; assign others to departments, teams or people.</CardDescription></CardHeader>
          <CardContent>
            <ul className="divide-y">
              {policies.data.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{p.name}{p.isDefault ? <span className="text-muted-foreground"> · default for {p.leaveType.name}</span> : null}</p>
                    <p className="text-muted-foreground">
                      {p.accrual === 'NONE' ? 'No accrual' : `${p.accrualDays} days ${p.accrual === 'MONTHLY' ? 'monthly' : 'yearly'}`}
                      {p.capDays !== null ? ` · cap ${p.capDays}` : ''}
                      {p.carryOverMaxDays !== null ? ` · carry over up to ${p.carryOverMaxDays}` : ' · no carry-over'}
                      {p.allowNegative ? ' · may go negative' : ''} · approved by {p.approvalChain.map((r) => RULES[r].split(' (')[0].toLowerCase()).join(' then ')}
                      {p.assignments.length ? ` · ${p.assignments.length} assignment(s)` : ''}
                    </p>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => setEditing(p)}>Edit</Button>
                  {!p.isDefault ? <Button size="sm" variant="outline" onClick={() => setAssigning(p)}>Assign</Button> : null}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Leave types</CardTitle></CardHeader>
          <CardContent className="grid gap-4">
            <ul className="flex flex-wrap gap-2 text-sm">{types.data.map((t) => <li key={t.id} className="rounded-full bg-muted px-3 py-1">{t.name} <span className="text-muted-foreground">({t.code}{t.isPaid ? '' : ', unpaid'})</span></li>)}</ul>
            <form onSubmit={typeForm.handleSubmit((v) => addType.mutate(v))} className="grid gap-3 sm:grid-cols-[8rem_1fr_auto_auto] sm:items-end">
              <FormField label="Code" required>{(a) => <Input required pattern="[A-Za-z0-9_]{2,16}" {...a} {...typeForm.register('code')} />}</FormField>
              <FormField label="Name" required>{(a) => <Input required {...a} {...typeForm.register('name')} />}</FormField>
              <label className="flex items-center gap-2 pb-2 text-sm"><input type="checkbox" className="size-4 accent-[var(--primary)]" {...typeForm.register('isPaid')} /> Paid</label>
              <Button type="submit" disabled={addType.isPending}>Add type</Button>
            </form>
          </CardContent>
        </Card>
      </div>
      {editing ? <PolicyDialog policy={editing === 'new' ? null : editing} types={types.data.filter((t) => !t.archived)} onClose={() => setEditing(null)} /> : null}
      {assigning ? <AssignDialog policy={assigning} onClose={() => setAssigning(null)} /> : null}
    </>
  );
}
