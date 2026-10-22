'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { Briefcase, Building2, Hash, MoreHorizontal, UserRound } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { FormField } from '@/components/common/form-field';
import { MemberStatusBadge } from '@/components/common/status-badge';
import { useCan, useMe } from '@/features/session/session-provider';
import { api } from '@/lib/api';
import { useEmployeeAction, useInvalidateEmployees, useRoles } from '../queries';

const CONFIRMATIONS = {
  deactivate: {
    title: 'Deactivate this employee?',
    description: 'They are signed out everywhere immediately and cannot sign in until reactivated. Their records are kept.',
    action: 'Deactivate',
    destructive: true,
  },
  activate: { title: 'Reactivate this employee?', description: 'They can sign in again with their existing account.', action: 'Reactivate' },
  archive: {
    title: 'Archive this employee?',
    description: 'Archived employees are hidden from the directory. Their history stays available to authorized people.',
    action: 'Archive',
    destructive: true,
  },
};

function Meta({ icon: Icon, children }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
      <Icon className="size-4" aria-hidden />
      {children}
    </span>
  );
}

export function ProfileHeader({ employee }) {
  const me = useMe();
  const router = useRouter();
  const canLifecycle = useCan('employees.deactivate');
  const canRoles = useCan('roles.manage');
  const action = useEmployeeAction(employee.employeeId);
  const [confirm, setConfirm] = useState(null);
  const [dialog, setDialog] = useState(null);
  const isSelf = employee.employeeId === me.employeeId;

  async function run(kind, body, idempotencyKey) {
    try {
      await action.mutateAsync({ action: kind, body, idempotencyKey });
      toast.success(
        {
          deactivate: `${employee.name} was deactivated`,
          activate: `${employee.name} was reactivated`,
          archive: `${employee.name} was archived`,
          offboard: `${employee.name} was offboarded`,
        }[kind],
      );
      if (kind === 'archive') router.push('/employees');
    } catch (error) {
      toast.error(error.message);
    }
  }

  const menu = [];
  if (canLifecycle && !isSelf) {
    if (employee.status === 'ACTIVE') menu.push(['Deactivate', () => setConfirm('deactivate')], ['Offboard…', () => setDialog('offboard')]);
    if (['DEACTIVATED', 'SUSPENDED'].includes(employee.status)) menu.push(['Reactivate', () => setConfirm('activate')]);
    if (['DEACTIVATED', 'INVITED'].includes(employee.status)) menu.push(['Archive', () => setConfirm('archive')]);
  }
  if (canRoles) menu.push(['Manage roles…', () => setDialog('roles')]);

  const c = confirm && CONFIRMATIONS[confirm];
  return (
    <Card className="mb-4 p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <Avatar name={employee.name} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-xl font-semibold">{employee.name}</h1>
            <MemberStatusBadge status={employee.status} />
          </div>
          <p className="truncate text-sm text-muted-foreground">{employee.email}</p>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
            {employee.designation && <Meta icon={Briefcase}>{employee.designation}</Meta>}
            {employee.department && <Meta icon={Building2}>{employee.department.name}</Meta>}
            {employee.employeeCode && <Meta icon={Hash}>{employee.employeeCode}</Meta>}
            {employee.manager && <Meta icon={UserRound}>Reports to {employee.manager.name}</Meta>}
          </div>
        </div>
        {menu.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <MoreHorizontal aria-hidden /> Actions
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              {menu.map(([label, onSelect]) => (
                <DropdownMenuItem key={label} onSelect={onSelect}>
                  {label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <AlertDialog open={Boolean(confirm)} onOpenChange={(open) => !open && setConfirm(null)}>
        {c && (
          <AlertDialogContent>
            <AlertDialogTitle>{c.title}</AlertDialogTitle>
            <AlertDialogDescription>{c.description}</AlertDialogDescription>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction destructive={c.destructive} onClick={() => run(confirm)}>
                {c.action}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>
      {dialog === 'offboard' && <OffboardDialog employee={employee} onClose={() => setDialog(null)} onSubmit={(body, key) => run('offboard', body, key)} />}
      {dialog === 'roles' && <RolesDialog employee={employee} onClose={() => setDialog(null)} />}
    </Card>
  );
}

function OffboardDialog({ employee, onClose, onSubmit }) {
  const [key] = useState(() => crypto.randomUUID());
  const form = useForm({ defaultValues: { lastWorkingDate: new Date().toISOString().slice(0, 10), reason: '' } });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Offboard {employee.name}</DialogTitle>
          <DialogDescription>Records the last working day, signs them out, and revokes pending invitations.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={form.handleSubmit(async ({ lastWorkingDate, reason }) => {
            await onSubmit({ lastWorkingDate, ...(reason ? { reason } : {}) }, key);
            onClose();
          })}
        >
          <FormField label="Last working day" required>
            {(aria) => <Input type="date" required {...aria} {...form.register('lastWorkingDate', { required: true })} />}
          </FormField>
          <FormField label="Reason" hint="Optional. Visible in the audit log.">
            {(aria) => <Input {...aria} {...form.register('reason')} />}
          </FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={form.formState.isSubmitting}>
              Offboard
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RolesDialog({ employee, onClose }) {
  const roles = useRoles();
  const invalidate = useInvalidateEmployees();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState(() => new Set(employee.roles.map((r) => r.id)));
  const [saving, setSaving] = useState(false);
  async function save() {
    setSaving(true);
    try {
      await api.put(`/employees/${employee.employeeId}/roles`, { roleIds: [...selected] });
      toast.success('Roles updated');
      await invalidate();
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      onClose();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Roles for {employee.name}</DialogTitle>
          <DialogDescription>Permissions from all selected roles are combined.</DialogDescription>
        </DialogHeader>
        <fieldset className="grid gap-2">
          <legend className="sr-only">Roles</legend>
          {roles.data?.map((role) => (
            <label key={role.id} className="flex items-start gap-3 rounded-md border p-3 text-sm has-[:checked]:border-primary">
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-[var(--primary)]"
                checked={selected.has(role.id)}
                onChange={(e) =>
                  setSelected((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(role.id);
                    else next.delete(role.id);
                    return next;
                  })
                }
              />
              <span>
                <span className="block font-medium">{role.name}</span>
                {role.description && <span className="block text-muted-foreground">{role.description}</span>}
              </span>
            </label>
          ))}
        </fieldset>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={saving || selected.size === 0}>
            Save roles
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
