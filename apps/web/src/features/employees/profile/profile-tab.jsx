'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Lock, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, NativeSelect } from '@/components/ui/input';
import { FormField } from '@/components/common/form-field';
import { api } from '@/lib/api';
import { EMPLOYMENT_TYPE_LABEL, formatDate } from '@/lib/format';
import { applyServerErrors } from '@/lib/forms';
import { useDepartments, useEmployees, useInvalidateEmployees } from '../queries';

// Field definitions per group. `get` reads the current value from the employee payload; `toForm`
// and `fromForm` convert between API values and form strings.
const text = (label, get, extra = {}) => ({ label, type: 'text', get, ...extra });
const date = (label, get) => ({ label, type: 'date', get, display: (v) => (v ? formatDate(v) : null) });

const GROUPS = {
  basic: {
    title: 'Basic information',
    fields: {
      name: text('Full name', (e) => e.name, { required: true }),
      employeeCode: text('Employee ID', (e) => e.employeeCode),
      designation: text('Designation', (e) => e.designation),
      departmentId: { label: 'Department', type: 'department', get: (e) => e.department?.id ?? null, display: (_v, e) => e.department?.name },
      managerEmployeeId: { label: 'Manager', type: 'manager', get: (e) => e.manager?.employeeId ?? null, display: (_v, e) => e.manager?.name },
    },
  },
  work: {
    title: 'Work details',
    fields: {
      employmentType: { label: 'Employment type', type: 'employmentType', get: (e) => e.work.employmentType, display: (v) => EMPLOYMENT_TYPE_LABEL[v] },
      joiningDate: date('Joining date', (e) => e.work.joiningDate),
      workLocation: text('Work location', (e) => e.work.workLocation),
      timeZone: text('Time zone', (e) => e.work.timeZone, { hint: 'IANA name, e.g. Asia/Kolkata' }),
      skills: {
        label: 'Skills',
        type: 'text',
        hint: 'Comma-separated',
        get: (e) => e.work.skills,
        display: (v) => v?.join(', '),
        toForm: (v) => (v ?? []).join(', '),
        fromForm: (s) => {
          const list = s.split(',').map((x) => x.trim()).filter(Boolean);
          return list.length ? list : null;
        },
      },
    },
  },
  contact: { title: 'Contact', fields: { phone: text('Phone', (e) => e.contact.phone, { inputType: 'tel' }) } },
  personal: {
    title: 'Personal details',
    sensitive: true,
    fields: {
      personalEmail: text('Personal email', (e) => e.personal.personalEmail, { inputType: 'email' }),
      address: { label: 'Address', type: 'address', get: (e) => e.personal.address, display: (a) => (a ? [a.line1, a.line2, a.city, a.region, a.postalCode, a.country].filter(Boolean).join(', ') : null) },
    },
  },
  emergency: {
    title: 'Emergency contact',
    sensitive: true,
    fields: {
      emergencyContact: {
        label: 'Emergency contact',
        type: 'emergency',
        get: (e) => e.emergency.emergencyContact,
        display: (c) => (c ? `${c.name} (${c.relationship}) · ${c.phone}` : null),
      },
    },
  },
  employment: {
    title: 'Employment terms',
    fields: {
      probationEndDate: date('Probation ends', (e) => e.employment.probationEndDate),
      noticePeriodDays: {
        label: 'Notice period (days)',
        type: 'text',
        inputType: 'number',
        get: (e) => e.employment.noticePeriodDays,
        toForm: (v) => (v === null || v === undefined ? '' : String(v)),
        fromForm: (s) => (s === '' ? null : Number(s)),
      },
      lastWorkingDate: date('Last working day', (e) => e.employment.lastWorkingDate),
    },
  },
};

const ADDRESS_PARTS = [
  ['line1', 'Address line 1'],
  ['line2', 'Address line 2'],
  ['city', 'City'],
  ['region', 'State / region'],
  ['postalCode', 'Postal code'],
  ['country', 'Country (2-letter code)'],
];
const EMERGENCY_PARTS = [
  ['name', 'Name'],
  ['relationship', 'Relationship'],
  ['phone', 'Phone'],
];

function toFormValue(def, value) {
  if (def.toForm) return def.toForm(value);
  if (def.type === 'address') return Object.fromEntries(ADDRESS_PARTS.map(([k]) => [k, value?.[k] ?? '']));
  if (def.type === 'emergency') return Object.fromEntries(EMERGENCY_PARTS.map(([k]) => [k, value?.[k] ?? '']));
  return value ?? '';
}

function fromFormValue(def, value) {
  if (def.fromForm) return def.fromForm(value);
  if (def.type === 'address' || def.type === 'emergency') {
    const cleaned = Object.fromEntries(Object.entries(value).filter(([, v]) => v.trim() !== '').map(([k, v]) => [k, v.trim()]));
    if (cleaned.country) cleaned.country = cleaned.country.toUpperCase();
    return Object.keys(cleaned).length ? cleaned : null;
  }
  return typeof value === 'string' && value.trim() === '' ? null : typeof value === 'string' ? value.trim() : value;
}

function GroupCard({ group, employee, editable }) {
  const config = GROUPS[group];
  const [editing, setEditing] = useState(false);
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-2">
        <div>
          <CardTitle>{config.title}</CardTitle>
          {config.sensitive && (
            <CardDescription className="flex items-center gap-1">
              <Lock className="size-3" aria-hidden /> Visible only to the employee and authorized HR roles
            </CardDescription>
          )}
        </div>
        {editable && (
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)} aria-label={`Edit ${config.title.toLowerCase()}`}>
            <Pencil aria-hidden /> Edit
          </Button>
        )}
      </CardHeader>
      <CardContent>
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          {Object.entries(config.fields).map(([key, def]) => {
            const value = def.get(employee);
            const shown = def.display ? def.display(value, employee) : value;
            return (
              <div key={key}>
                <dt className="text-xs text-muted-foreground">{def.label}</dt>
                <dd className="mt-0.5 text-sm font-medium break-words">{shown ?? <span className="font-normal text-muted-foreground">Not set</span>}</dd>
              </div>
            );
          })}
        </dl>
      </CardContent>
      {editing && <GroupEditDialog group={group} employee={employee} onClose={() => setEditing(false)} />}
    </Card>
  );
}

function GroupEditDialog({ group, employee, onClose }) {
  const config = GROUPS[group];
  const departments = useDepartments();
  const managers = useEmployees({ status: 'ACTIVE', limit: 100, sort: 'name' });
  const invalidate = useInvalidateEmployees();
  const initial = Object.fromEntries(Object.entries(config.fields).map(([k, def]) => [k, toFormValue(def, def.get(employee))]));
  const form = useForm({ defaultValues: initial });

  async function onSubmit(values) {
    // Send only changed fields: the API authorizes per field group and records per-field history.
    const patch = {};
    for (const [key, def] of Object.entries(config.fields)) {
      const next = fromFormValue(def, values[key]);
      if (JSON.stringify(next) !== JSON.stringify(def.get(employee) ?? null)) patch[key] = next;
    }
    if (Object.keys(patch).length === 0) return onClose();
    try {
      await api.patch(`/employees/${employee.employeeId}`, patch);
      toast.success(`${config.title} saved`);
      await invalidate();
      onClose();
    } catch (error) {
      if (!applyServerErrors(form, error)) toast.error(error.message);
    }
  }

  const err = (path) => path.split('.').reduce((o, k) => o?.[k], form.formState.errors)?.message;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit {config.title.toLowerCase()}</DialogTitle>
          <DialogDescription>{employee.name}</DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-4">
          {Object.entries(config.fields).map(([key, def]) => {
            if (def.type === 'address' || def.type === 'emergency') {
              const parts = def.type === 'address' ? ADDRESS_PARTS : EMERGENCY_PARTS;
              return (
                <fieldset key={key} className="grid gap-3 sm:grid-cols-2">
                  <legend className="mb-2 text-sm font-medium">{def.label}</legend>
                  {parts.map(([part, label]) => (
                    <FormField key={part} label={label} error={err(`${key}.${part}`)}>
                      {(aria) => <Input {...aria} {...form.register(`${key}.${part}`)} />}
                    </FormField>
                  ))}
                </fieldset>
              );
            }
            return (
              <FormField key={key} label={def.label} hint={def.hint} required={def.required} error={err(key)}>
                {(aria) => {
                  if (def.type === 'department') {
                    return (
                      <NativeSelect {...aria} {...form.register(key)}>
                        <option value="">None</option>
                        {departments.data?.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.name}
                          </option>
                        ))}
                      </NativeSelect>
                    );
                  }
                  if (def.type === 'manager') {
                    return (
                      <NativeSelect {...aria} {...form.register(key)}>
                        <option value="">No manager</option>
                        {managers.data?.data
                          .filter((m) => m.employeeId !== employee.employeeId)
                          .map((m) => (
                            <option key={m.employeeId} value={m.employeeId}>
                              {m.name}
                            </option>
                          ))}
                      </NativeSelect>
                    );
                  }
                  if (def.type === 'employmentType') {
                    return (
                      <NativeSelect {...aria} {...form.register(key)}>
                        <option value="">Not set</option>
                        {Object.entries(EMPLOYMENT_TYPE_LABEL).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </NativeSelect>
                    );
                  }
                  return <Input type={def.type === 'date' ? 'date' : (def.inputType ?? 'text')} {...aria} {...form.register(key)} />;
                }}
              </FormField>
            );
          })}
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

export function ProfileTab({ employee }) {
  const { readableGroups, editableGroups } = employee.access;
  const groups = Object.keys(GROUPS).filter((g) => readableGroups.includes(g));
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {groups.map((group) => (
        <GroupCard key={group} group={group} employee={employee} editable={editableGroups.includes(group)} />
      ))}
    </div>
  );
}
