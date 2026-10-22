'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { emailSchema, z } from '@orbit/validation';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input, NativeSelect } from '@/components/ui/input';
import { FormField } from '@/components/common/form-field';
import { api } from '@/lib/api';
import { applyServerErrors, emptyToNull } from '@/lib/forms';
import { EMPLOYMENT_TYPE_LABEL } from '@/lib/format';
import { useDepartments, useInvalidateEmployees, useRoles, useTeams } from './queries';

const schema = z.object({
  email: emailSchema,
  name: z.string().trim().min(1, 'Enter a name').max(160),
  designation: z.string().trim().max(120),
  departmentId: z.string(),
  teamId: z.string(),
  roleId: z.string(),
  employmentType: z.string(),
  joiningDate: z.string(),
  sendInvitation: z.boolean(),
});

const DEFAULTS = { email: '', name: '', designation: '', departmentId: '', teamId: '', roleId: '', employmentType: '', joiningDate: '', sendInvitation: true };

export function InviteEmployeeDialog() {
  const [open, setOpen] = useState(false);
  // One key per dialog session: a double submit or network retry cannot create two invitations.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const departments = useDepartments();
  const teams = useTeams();
  const roles = useRoles();
  const invalidate = useInvalidateEmployees();
  const form = useForm({ resolver: zodResolver(schema), defaultValues: DEFAULTS });

  function onOpenChange(next) {
    setOpen(next);
    if (next) {
      form.reset(DEFAULTS);
      setIdempotencyKey(crypto.randomUUID());
    }
  }

  async function onSubmit(values) {
    const body = {
      email: values.email,
      name: values.name,
      designation: emptyToNull(values.designation),
      departmentId: emptyToNull(values.departmentId),
      teamIds: values.teamId ? [values.teamId] : [],
      employmentType: emptyToNull(values.employmentType),
      joiningDate: emptyToNull(values.joiningDate),
      sendInvitation: values.sendInvitation,
      ...(values.roleId ? { roleIds: [values.roleId] } : {}),
    };
    try {
      await api.post('/employees', body, { idempotencyKey });
      toast.success(values.sendInvitation ? `Invitation sent to ${values.email}` : `${values.name} added`);
      await invalidate();
      setOpen(false);
    } catch (error) {
      if (!applyServerErrors(form, error)) toast.error(error.message);
    }
  }

  const e = form.formState.errors;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button>
          <UserPlus aria-hidden /> Invite employee
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite an employee</DialogTitle>
          <DialogDescription>They receive an email to set a password and join. The link expires in 7 days.</DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Full name" required error={e.name?.message}>
              {(aria) => <Input autoFocus {...aria} {...form.register('name')} />}
            </FormField>
            <FormField label="Work email" required error={e.email?.message}>
              {(aria) => <Input type="email" {...aria} {...form.register('email')} />}
            </FormField>
            <FormField label="Designation" error={e.designation?.message}>
              {(aria) => <Input {...aria} {...form.register('designation')} />}
            </FormField>
            <FormField label="Employment type">
              {(aria) => (
                <NativeSelect {...aria} {...form.register('employmentType')}>
                  <option value="">Not set</option>
                  {Object.entries(EMPLOYMENT_TYPE_LABEL).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </FormField>
            <FormField label="Department" error={e.departmentId?.message}>
              {(aria) => (
                <NativeSelect {...aria} {...form.register('departmentId')}>
                  <option value="">None</option>
                  {departments.data?.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </FormField>
            <FormField label="Team" error={e.teamIds?.message}>
              {(aria) => (
                <NativeSelect {...aria} {...form.register('teamId')}>
                  <option value="">None</option>
                  {teams.data?.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </FormField>
            <FormField label="Role" hint="Defaults to Employee." error={e.roleIds?.message}>
              {(aria) => (
                <NativeSelect {...aria} {...form.register('roleId')}>
                  <option value="">Employee (default)</option>
                  {roles.data
                    ?.filter((r) => r.key !== 'EMPLOYEE' && r.key !== 'OWNER')
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                </NativeSelect>
              )}
            </FormField>
            <FormField label="Joining date" error={e.joiningDate?.message}>
              {(aria) => <Input type="date" {...aria} {...form.register('joiningDate')} />}
            </FormField>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-[var(--primary)]" {...form.register('sendInvitation')} />
            Send the invitation email now
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={form.formState.isSubmitting}>
              Send invitation
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
