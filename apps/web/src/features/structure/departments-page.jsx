'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Building2, Pencil, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, NativeSelect } from '@/components/ui/input';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { FormField } from '@/components/common/form-field';
import { PageHeader } from '@/components/common/page-header';
import { EmptyState } from '@/components/common/states';
import { DataTable } from '@/components/data-tables/data-table';
import { useCan } from '@/features/session/session-provider';
import { useDepartments, useEmployees, useInvalidateEmployees } from '@/features/employees/queries';
import { api } from '@/lib/api';
import { applyServerErrors, emptyToNull } from '@/lib/forms';

function DepartmentDialog({ department, departments, onClose }) {
  const invalidate = useInvalidateEmployees();
  const people = useEmployees({ status: 'ACTIVE', limit: 100, sort: 'name' });
  const form = useForm({
    defaultValues: {
      name: department?.name ?? '',
      code: department?.code ?? '',
      parentId: department?.parentId ?? '',
      managerEmployeeId: department?.manager?.employeeId ?? '',
    },
  });
  async function onSubmit(values) {
    const body = { name: values.name, code: values.code, parentId: emptyToNull(values.parentId), managerEmployeeId: emptyToNull(values.managerEmployeeId) };
    try {
      if (department) await api.patch(`/departments/${department.id}`, body);
      else await api.post('/departments', body);
      toast.success(department ? 'Department updated' : 'Department created');
      await invalidate();
      onClose();
    } catch (error) {
      if (!applyServerErrors(form, error)) toast.error(error.message);
    }
  }
  const e = form.formState.errors;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{department ? `Edit ${department.name}` : 'New department'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Name" required error={e.name?.message}>
              {(aria) => <Input {...aria} {...form.register('name', { required: 'Enter a name' })} />}
            </FormField>
            <FormField label="Code" required hint="Short unique code, e.g. ENG" error={e.code?.message}>
              {(aria) => <Input {...aria} {...form.register('code', { required: 'Enter a code' })} />}
            </FormField>
          </div>
          <FormField label="Parent department" error={e.parentId?.message}>
            {(aria) => (
              <NativeSelect {...aria} {...form.register('parentId')}>
                <option value="">None (top level)</option>
                {departments
                  .filter((d) => d.id !== department?.id)
                  .map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
              </NativeSelect>
            )}
          </FormField>
          <FormField label="Manager" error={e.managerEmployeeId?.message}>
            {(aria) => (
              <NativeSelect {...aria} {...form.register('managerEmployeeId')}>
                <option value="">No manager</option>
                {people.data?.data.map((p) => (
                  <option key={p.employeeId} value={p.employeeId}>
                    {p.name}
                  </option>
                ))}
              </NativeSelect>
            )}
          </FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={form.formState.isSubmitting}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function DepartmentsPage() {
  const departments = useDepartments();
  const canManage = useCan('departments.manage');
  const invalidate = useInvalidateEmployees();
  const [editing, setEditing] = useState(null);
  const [archiving, setArchiving] = useState(null);
  const list = departments.data ?? [];
  const nameOf = (id) => list.find((d) => d.id === id)?.name;

  async function archive() {
    try {
      await api.delete(`/departments/${archiving.id}`);
      toast.success(`${archiving.name} archived`);
      await invalidate();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setArchiving(null);
    }
  }

  const columns = [
    { key: 'name', header: 'Department', cell: (d) => <span className="font-medium">{d.name}</span> },
    { key: 'code', header: 'Code', cell: (d) => <code className="text-xs">{d.code}</code> },
    { key: 'parent', header: 'Parent', cell: (d) => nameOf(d.parentId) ?? '—', className: 'hidden md:table-cell' },
    { key: 'manager', header: 'Manager', cell: (d) => d.manager?.name ?? '—', className: 'hidden md:table-cell' },
    { key: 'count', header: 'People', cell: (d) => <span className="tabular-nums">{d.employeeCount}</span> },
    ...(canManage
      ? [
          {
            key: 'actions',
            header: <span className="sr-only">Actions</span>,
            className: 'text-right',
            cell: (d) => (
              <div className="flex justify-end gap-1">
                <Button variant="ghost" size="sm" onClick={() => setEditing(d)} aria-label={`Edit ${d.name}`}>
                  <Pencil aria-hidden />
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setArchiving(d)}>
                  Archive
                </Button>
              </div>
            ),
          },
        ]
      : []),
  ];

  return (
    <>
      <PageHeader
        title="Departments"
        description="Departments group people and give their managers access to their subtree."
        actions={
          canManage && (
            <Button onClick={() => setEditing('new')}>
              <Plus aria-hidden /> New department
            </Button>
          )
        }
      />
      <Card>
        <DataTable
          caption="Departments"
          columns={columns}
          rows={list}
          isPending={departments.isPending}
          error={departments.error}
          onRetry={() => departments.refetch()}
          empty={<EmptyState icon={Building2} title="No departments yet" description={canManage ? 'Create your first department.' : undefined} />}
        />
      </Card>
      {editing && <DepartmentDialog department={editing === 'new' ? null : editing} departments={list} onClose={() => setEditing(null)} />}
      <AlertDialog open={Boolean(archiving)} onOpenChange={(open) => !open && setArchiving(null)}>
        <AlertDialogContent>
          <AlertDialogTitle>Archive {archiving?.name}?</AlertDialogTitle>
          <AlertDialogDescription>It disappears from lists and pickers. People keep their history. Sub-departments must be archived first.</AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction destructive onClick={archive}>
              Archive
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
