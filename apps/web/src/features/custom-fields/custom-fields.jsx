'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, NativeSelect } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { FormField } from '@/components/common/form-field';
import { PageHeader } from '@/components/common/page-header';
import { ErrorState } from '@/components/common/states';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useAction } from '@/features/crm/queries';

const ENTITY = { EMPLOYEE: 'Employees', PROJECT: 'Projects', TASK: 'Tasks', CLIENT: 'Clients', TICKET: 'Support tickets' };
const TYPE = { TEXT: 'Text', NUMBER: 'Number', DATE: 'Date', SELECT: 'One choice', MULTI_SELECT: 'Several choices', BOOLEAN: 'Yes / no' };

function display(f) {
  if (f.value === null || f.value === undefined || (Array.isArray(f.value) && !f.value.length)) return '—';
  if (f.type === 'BOOLEAN') return f.value ? 'Yes' : 'No';
  if (f.type === 'DATE') return formatDate(f.value);
  if (f.type === 'MULTI_SELECT') return f.value.join(', ');
  return String(f.value);
}

function FieldInput({ field, register }) {
  const name = `values.${field.key}`;
  return (
    <FormField label={field.label} required={field.required}>
      {(a) => {
        switch (field.type) {
          case 'NUMBER':
            return <Input inputMode="decimal" pattern="-?\d+(\.\d{1,4})?" {...a} {...register(name)} />;
          case 'DATE':
            return <Input type="date" {...a} {...register(name)} />;
          case 'BOOLEAN':
            return <NativeSelect {...a} {...register(name)}><option value="">—</option><option value="true">Yes</option><option value="false">No</option></NativeSelect>;
          case 'SELECT':
            return <NativeSelect {...a} {...register(name)}><option value="">—</option>{field.options.map((o) => <option key={o} value={o}>{o}</option>)}</NativeSelect>;
          case 'MULTI_SELECT':
            return <select multiple size={Math.min(5, field.options.length)} className="rounded-md border bg-card px-2 py-1 text-sm" {...a} {...register(name)}>{field.options.map((o) => <option key={o} value={o}>{o}</option>)}</select>;
          default:
            return <Input maxLength={1000} {...a} {...register(name)} />;
        }
      }}
    </FormField>
  );
}

/** Custom fields of one record. Hidden when the organization defines none for this record type; editable when the API says so. */
export function CustomFieldsCard({ entity, entityId }) {
  const path = `/custom-fields/values/${entity}/${entityId}`;
  const fields = useQuery({ queryKey: ['custom-fields', entity, entityId], queryFn: () => api.get(path), retry: false });
  const [editing, setEditing] = useState(false);
  const form = useForm();
  const save = useAction(
    (v) => {
      const values = Object.fromEntries(
        fields.data.data.map((f) => {
          const raw = v.values?.[f.key];
          if (f.type === 'BOOLEAN') return [f.key, raw === '' || raw === undefined ? null : raw === 'true'];
          if (f.type === 'MULTI_SELECT') return [f.key, Array.isArray(raw) ? raw : raw ? [raw] : []];
          return [f.key, raw === '' || raw === undefined ? null : raw];
        }),
      );
      return api.put(path, { values });
    },
    { success: 'Saved', keys: [['custom-fields', entity, entityId]], onSuccess: () => setEditing(false) },
  );
  if (fields.isPending) return <Skeleton className="h-16" />;
  if (fields.error || !fields.data.data.length) return null;
  const rows = fields.data.data;
  const canEdit = fields.data.meta.canEdit;
  const startEdit = () => {
    form.reset({ values: Object.fromEntries(rows.map((f) => [f.key, f.type === 'BOOLEAN' ? (f.value === null ? '' : String(f.value)) : (f.value ?? (f.type === 'MULTI_SELECT' ? [] : ''))])) });
    setEditing(true);
  };
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-2">
        <CardTitle>More details</CardTitle>
        {canEdit && !editing ? <Button size="sm" variant="outline" onClick={startEdit}>Edit</Button> : null}
      </CardHeader>
      <CardContent>
        {editing ? (
          <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="grid gap-4 sm:grid-cols-2">
            {rows.map((f) => <FieldInput key={f.id} field={f} register={form.register} />)}
            <div className="flex gap-2 sm:col-span-2">
              <Button type="submit" disabled={save.isPending}>Save</Button>
              <Button type="button" variant="outline" onClick={() => setEditing(false)}>Cancel</Button>
            </div>
          </form>
        ) : (
          <dl className="grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-4 gap-y-2 text-sm">
            {rows.map((f) => (
              <div key={f.id} className="contents">
                <dt className="text-muted-foreground">{f.label}</dt>
                <dd>{display(f)}</dd>
              </div>
            ))}
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

export function CustomFieldsSettings() {
  const fields = useQuery({ queryKey: ['custom-fields', 'definitions'], queryFn: async () => (await api.get('/custom-fields', { query: { includeArchived: 'true' } })).data });
  const form = useForm({ defaultValues: { entity: 'EMPLOYEE', label: '', key: '', type: 'TEXT', options: '', required: false } });
  const add = useAction(
    (v) => api.post('/custom-fields', { entity: v.entity, label: v.label, key: v.key || v.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'f_$1').slice(0, 48), type: v.type, required: v.required, ...(['SELECT', 'MULTI_SELECT'].includes(v.type) ? { options: v.options.split(',').map((o) => o.trim()).filter(Boolean) } : {}) }),
    { success: 'Field added', keys: [['custom-fields']], onSuccess: () => form.reset() },
  );
  const archive = useAction(({ id, archived }) => api.patch(`/custom-fields/${id}`, { archived }), { keys: [['custom-fields']] });
  return (
    <>
      <PageHeader title="Custom fields" description="Extra details your organization records on people, projects, tasks, clients and tickets. Who can see or edit them follows the record itself." />
      <div className="grid gap-6">
        <Card>
          <CardHeader><CardTitle>Add a field</CardTitle></CardHeader>
          <CardContent>
            <form onSubmit={form.handleSubmit((v) => add.mutate(v))} className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6 lg:items-start">
              <FormField label="Record type">{(a) => <NativeSelect {...a} {...form.register('entity')}>{Object.entries(ENTITY).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</NativeSelect>}</FormField>
              <FormField label="Label" required>{(a) => <Input required maxLength={120} {...a} {...form.register('label')} />}</FormField>
              <FormField label="Key" hint="Optional, for the API">{(a) => <Input pattern="[a-z][a-z0-9_]{1,47}" {...a} {...form.register('key')} />}</FormField>
              <FormField label="Type">{(a) => <NativeSelect {...a} {...form.register('type')}>{Object.entries(TYPE).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</NativeSelect>}</FormField>
              <FormField label="Choices" hint="Comma-separated">{(a) => <Input {...a} {...form.register('options')} />}</FormField>
              <div className="flex items-center gap-3 lg:pt-6">
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="size-4 accent-[var(--primary)]" {...form.register('required')} /> Required</label>
                <Button type="submit" disabled={add.isPending}>Add</Button>
              </div>
            </form>
          </CardContent>
        </Card>
        {fields.isPending ? <Skeleton className="h-40" /> : fields.error ? <ErrorState error={fields.error} /> : (
          Object.entries(ENTITY).map(([entity, label]) => {
            const rows = fields.data.filter((f) => f.entity === entity);
            if (!rows.length) return null;
            return (
              <Card key={entity}>
                <CardHeader><CardTitle>{label}</CardTitle><CardDescription>{rows.filter((r) => !r.archived).length} active field(s)</CardDescription></CardHeader>
                <CardContent>
                  <ul className="divide-y text-sm">
                    {rows.map((f) => (
                      <li key={f.id} className="flex flex-wrap items-center gap-3 py-2">
                        <span className={f.archived ? 'flex-1 text-muted-foreground line-through' : 'flex-1'}>{f.label} <span className="font-mono text-xs text-muted-foreground">{f.key}</span> · {TYPE[f.type]}{f.options.length ? ` (${f.options.join(', ')})` : ''}{f.required ? ' · required' : ''}</span>
                        <Button size="sm" variant="ghost" onClick={() => archive.mutate({ id: f.id, archived: !f.archived })}>{f.archived ? 'Restore' : 'Archive'}</Button>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            );
          })
        )}
      </div>
    </>
  );
}
