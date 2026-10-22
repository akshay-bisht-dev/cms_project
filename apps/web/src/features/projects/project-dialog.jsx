'use client';

import { useForm } from 'react-hook-form';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, NativeSelect, Textarea } from '@/components/ui/input';
import { FormField } from '@/components/common/form-field';
import { useEmployees } from '@/features/employees/queries';
import { api } from '@/lib/api';
import { applyServerErrors, emptyToNull } from '@/lib/forms';
import { PRIORITIES, PROJECT_STATUSES } from './badges';
import { useInvalidateWork } from './queries';

/** Create or edit a project. Budget fields only render for people allowed to see budgets. */
export function ProjectDialog({ project, onClose }) {
  const router = useRouter();
  const invalidate = useInvalidateWork();
  const people = useEmployees({ status: 'ACTIVE', limit: 100, sort: 'name' });
  const canBudget = !project || project.access?.canSeeBudget;
  const form = useForm({
    defaultValues: {
      name: project?.name ?? '',
      code: project?.code ?? '',
      description: project?.description ?? '',
      status: project?.status ?? 'PLANNED',
      priority: project?.priority ?? 'MEDIUM',
      visibility: project?.visibility ?? 'PRIVATE',
      startDate: project?.startDate ?? '',
      deadline: project?.deadline ?? '',
      estimatedH: project?.estimatedS ? String(project.estimatedS / 3600) : '',
      managerEmployeeId: project?.manager?.employeeId ?? '',
      budgetAmount: project?.budget?.amount ?? '',
      budgetCurrency: project?.budget?.currency ?? 'USD',
    },
  });

  async function onSubmit(v) {
    const body = {
      name: v.name,
      ...(v.code ? { code: v.code } : {}),
      description: emptyToNull(v.description),
      status: v.status,
      priority: v.priority,
      visibility: v.visibility,
      startDate: emptyToNull(v.startDate),
      deadline: emptyToNull(v.deadline),
      estimatedS: v.estimatedH === '' ? null : Math.round(Number(v.estimatedH) * 3600),
      ...(v.managerEmployeeId ? { managerEmployeeId: v.managerEmployeeId } : {}),
      ...(canBudget ? { budget: v.budgetAmount ? { amount: v.budgetAmount, currency: v.budgetCurrency.toUpperCase() } : null } : {}),
    };
    try {
      const { data } = project ? await api.patch(`/projects/${project.id}`, body) : await api.post('/projects', body);
      toast.success(project ? 'Project updated' : 'Project created');
      await invalidate();
      onClose();
      if (!project) router.push(`/projects/${data.id}/board`);
    } catch (error) {
      if (!applyServerErrors(form, error)) toast.error(error.message);
    }
  }

  const e = form.formState.errors;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{project ? `Edit ${project.name}` : 'New project'}</DialogTitle>
          <DialogDescription>{project ? 'Changes apply immediately.' : 'You become the project manager unless you choose someone else.'}</DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
            <FormField label="Name" required error={e.name?.message}>
              {(aria) => <Input autoFocus {...aria} {...form.register('name', { required: 'Enter a name' })} />}
            </FormField>
            <FormField label="Code" hint={project ? undefined : 'Generated if empty'} error={e.code?.message}>
              {(aria) => <Input maxLength={32} {...aria} {...form.register('code')} />}
            </FormField>
          </div>
          <FormField label="Description">{(aria) => <Textarea {...aria} {...form.register('description')} />}</FormField>
          <div className="grid gap-4 sm:grid-cols-3">
            <FormField label="Status">
              {(aria) => (
                <NativeSelect {...aria} {...form.register('status')}>
                  {PROJECT_STATUSES.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </FormField>
            <FormField label="Priority">
              {(aria) => (
                <NativeSelect {...aria} {...form.register('priority')}>
                  {PRIORITIES.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </FormField>
            <FormField label="Visibility">
              {(aria) => (
                <NativeSelect {...aria} {...form.register('visibility')}>
                  <option value="PRIVATE">Members only</option>
                  <option value="ORG">Everyone in the organization</option>
                </NativeSelect>
              )}
            </FormField>
            <FormField label="Start date">{(aria) => <Input type="date" {...aria} {...form.register('startDate')} />}</FormField>
            <FormField label="Deadline">{(aria) => <Input type="date" {...aria} {...form.register('deadline')} />}</FormField>
            <FormField label="Estimate (hours)" error={e.estimatedS?.message}>
              {(aria) => <Input type="number" min={0} step="0.5" {...aria} {...form.register('estimatedH')} />}
            </FormField>
          </div>
          <FormField label="Project manager">
            {(aria) => (
              <NativeSelect {...aria} {...form.register('managerEmployeeId')}>
                <option value="">{project ? 'Unchanged' : 'Me'}</option>
                {people.data?.data.map((p) => (
                  <option key={p.employeeId} value={p.employeeId}>
                    {p.name}
                  </option>
                ))}
              </NativeSelect>
            )}
          </FormField>
          {canBudget && (
            <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
              <FormField label="Budget" hint="Exact amount, e.g. 25000.00" error={e['budget.amount']?.message}>
                {(aria) => <Input inputMode="decimal" {...aria} {...form.register('budgetAmount')} />}
              </FormField>
              <FormField label="Currency">{(aria) => <Input maxLength={3} {...aria} {...form.register('budgetCurrency')} />}</FormField>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={form.formState.isSubmitting}>
              {project ? 'Save' : 'Create project'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
