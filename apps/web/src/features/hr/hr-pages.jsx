'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { CheckSquare, Download, FileText, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, NativeSelect } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FormField } from '@/components/common/form-field';
import { PageHeader } from '@/components/common/page-header';
import { EmptyState, ErrorState } from '@/components/common/states';
import { DataTable } from '@/components/data-tables/data-table';
import { useCan } from '@/features/session/session-provider';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useAction } from '@/features/crm/queries';

const TYPES = { CONTRACT: 'Contract', OFFER_LETTER: 'Offer letter', ID_PROOF: 'ID proof', TAX: 'Tax', CERTIFICATE: 'Certificate', POLICY_ACK: 'Policy acknowledgement', PERFORMANCE: 'Performance', OTHER: 'Other' };
const keys = [['hr']];

function UploadDialog({ employeeId, onClose }) {
  const form = useForm({ defaultValues: { title: '', type: 'CONTRACT', visibility: 'HR_ONLY', expiresOn: '' } });
  const [file, setFile] = useState(null);
  const upload = useAction(
    async (v) => {
      const { data } = await api.post(`/employees/${employeeId}/documents/uploads`, { fileName: file.name, contentType: file.type, sizeBytes: file.size });
      const put = await fetch(data.upload.url, { method: 'PUT', headers: data.upload.headers, body: file });
      if (!put.ok) throw new Error('The upload failed');
      await api.post(`/employees/${employeeId}/documents`, { fileId: data.fileId, type: v.type, title: v.title, visibility: v.visibility, ...(v.expiresOn ? { expiresOn: v.expiresOn } : {}) });
    },
    { success: 'Document added', keys, onSuccess: onClose },
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Add a document</DialogTitle><DialogDescription>Stored privately. “Shared with the employee” lets them see and download it.</DialogDescription></DialogHeader>
        <form onSubmit={form.handleSubmit((v) => (file ? upload.mutate(v) : toast.error('Choose a file')))} className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2"><FormField label="File" required hint="PDF, Word or image">{(a) => <Input type="file" required accept="application/pdf,image/png,image/jpeg,.doc,.docx" {...a} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />}</FormField></div>
          <FormField label="Title" required>{(a) => <Input required maxLength={200} {...a} {...form.register('title')} />}</FormField>
          <FormField label="Type">{(a) => <NativeSelect {...a} {...form.register('type')}>{Object.entries(TYPES).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</NativeSelect>}</FormField>
          <FormField label="Visible to">{(a) => <NativeSelect {...a} {...form.register('visibility')}><option value="HR_ONLY">HR only</option><option value="EMPLOYEE">Shared with the employee</option></NativeSelect>}</FormField>
          <FormField label="Expires on">{(a) => <Input type="date" {...a} {...form.register('expiresOn')} />}</FormField>
          <DialogFooter className="sm:col-span-2">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={upload.isPending}>Upload</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

async function download(employeeId, documentId) {
  try {
    const { data } = await api.get(`/employees/${employeeId}/documents/${documentId}/download`);
    window.location.assign(data.url);
  } catch (error) {
    toast.error(error.message);
  }
}

export function EmployeeDocuments({ employeeId }) {
  const canManage = useCan('documents.hr.manage');
  const [uploading, setUploading] = useState(false);
  const docs = useQuery({ queryKey: ['hr', 'documents', employeeId], queryFn: async () => (await api.get(`/employees/${employeeId}/documents`)).data, retry: false });
  const archive = useAction((id) => api.delete(`/employees/${employeeId}/documents/${id}`), { success: 'Document archived', keys });
  if (docs.error?.status === 403) return null;
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-2">
        <div><CardTitle>Employment documents</CardTitle><CardDescription>Private files; every download is audited.</CardDescription></div>
        {canManage ? <Button size="sm" onClick={() => setUploading(true)}><Upload aria-hidden /> Add</Button> : null}
      </CardHeader>
      <CardContent>
        {docs.isPending ? <Skeleton className="h-16" /> : docs.error ? <ErrorState error={docs.error} /> : docs.data.length ? (
          <ul className="divide-y text-sm">
            {docs.data.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-3 py-2">
                <FileText aria-hidden className="size-4 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{d.title}</span> <span className="text-muted-foreground">· {TYPES[d.type]}{d.expiresOn ? ` · expires ${formatDate(d.expiresOn)}` : ''}</span>
                </span>
                {canManage ? <Badge tone={d.visibility === 'EMPLOYEE' ? 'info' : 'neutral'}>{d.visibility === 'EMPLOYEE' ? 'Shared' : 'HR only'}</Badge> : null}
                <Button size="sm" variant="ghost" onClick={() => download(employeeId, d.id)}><Download aria-hidden /> Download<span className="sr-only"> {d.title}</span></Button>
                {canManage ? <Button size="sm" variant="ghost" onClick={() => window.confirm('Archive this document?') && archive.mutate(d.id)}>Archive</Button> : null}
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-muted-foreground">No documents.</p>}
      </CardContent>
      {uploading ? <UploadDialog employeeId={employeeId} onClose={() => setUploading(false)} /> : null}
    </Card>
  );
}

export function EmployeeChecklists({ employeeId }) {
  const canStart = useCan('employees.create');
  const lists = useQuery({ queryKey: ['hr', 'checklists', employeeId], queryFn: async () => (await api.get(`/employees/${employeeId}/checklists`)).data, retry: false });
  const toggle = useAction(({ id, done }) => api.post(`/checklist-tasks/${id}/done`, { done }), { keys });
  const start = useAction((kind) => api.post(`/employees/${employeeId}/checklists`, { kind }), { success: 'Checklist started', keys });
  if (lists.error?.status === 403 || lists.error?.status === 404) return null;
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-2">
        <div><CardTitle>Onboarding & offboarding</CardTitle></div>
        {canStart ? <span className="flex gap-2"><Button size="sm" variant="outline" onClick={() => start.mutate('ONBOARDING')}>Start onboarding</Button><Button size="sm" variant="outline" onClick={() => start.mutate('OFFBOARDING')}>Start offboarding</Button></span> : null}
      </CardHeader>
      <CardContent className="grid gap-4">
        {lists.isPending ? <Skeleton className="h-16" /> : lists.error ? <ErrorState error={lists.error} /> : lists.data.length ? lists.data.map((c) => (
          <section key={c.id} aria-label={c.name} className="grid gap-2">
            <p className="text-sm font-medium">{c.name} <span className="font-normal text-muted-foreground">· started {formatDate(c.startedAt)}{c.completedAt ? ` · completed ${formatDate(c.completedAt)}` : ''}</span></p>
            <ul className="grid gap-1.5">
              {c.tasks.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <input id={`task-${t.id}`} type="checkbox" className="size-4 accent-[var(--primary)]" checked={Boolean(t.doneAt)} disabled={!t.canComplete || toggle.isPending} onChange={(e) => toggle.mutate({ id: t.id, done: e.target.checked })} />
                  <label htmlFor={`task-${t.id}`} className={t.doneAt ? 'text-muted-foreground line-through' : ''}>{t.title}</label>
                  <span className="text-xs text-muted-foreground">· {t.assignee.name}{t.dueDate ? ` · due ${formatDate(t.dueDate)}` : ''}</span>
                </li>
              ))}
            </ul>
          </section>
        )) : <p className="text-sm text-muted-foreground">No checklists.</p>}
      </CardContent>
    </Card>
  );
}

export function ChecklistsPage() {
  const tasks = useQuery({ queryKey: ['hr', 'my-tasks'], queryFn: async () => (await api.get('/checklist-tasks')).data });
  const done = useAction((id) => api.post(`/checklist-tasks/${id}/done`, { done: true }), { success: 'Done', keys });
  return (
    <>
      <PageHeader title="Checklists" description="Onboarding and offboarding tasks assigned to you." />
      <Card>
        <DataTable
          caption="My checklist tasks"
          rows={tasks.data ?? []}
          isPending={tasks.isPending}
          error={tasks.error}
          onRetry={() => tasks.refetch()}
          empty={<EmptyState icon={CheckSquare} title="Nothing to do" />}
          columns={[
            { key: 'title', header: 'Task', cell: (t) => <span className="font-medium">{t.title}</span> },
            { key: 'who', header: 'For', cell: (t) => (t.employee.id ? <Link href={`/employees/${t.employee.id}/documents`} className="hover:underline">{t.employee.name}</Link> : t.employee.name) },
            { key: 'kind', header: 'Checklist', cell: (t) => (t.kind === 'ONBOARDING' ? 'Onboarding' : 'Offboarding'), className: 'hidden sm:table-cell' },
            { key: 'due', header: 'Due', cell: (t) => formatDate(t.dueDate) },
            { key: 'done', header: <span className="sr-only">Actions</span>, cell: (t) => <Button size="sm" variant="outline" onClick={() => done.mutate(t.id)}>Mark done<span className="sr-only">: {t.title}</span></Button> },
          ]}
        />
      </Card>
    </>
  );
}

export function DocumentsPage() {
  const docs = useQuery({ queryKey: ['hr', 'expiring'], queryFn: async () => (await api.get('/hr/documents/expiring', { query: { days: 60 } })).data });
  return (
    <>
      <PageHeader title="Documents" description="Employment documents expired or expiring in the next 60 days. Open a person’s profile to manage their files." />
      <Card>
        <DataTable
          caption="Expiring documents"
          rows={docs.data ?? []}
          isPending={docs.isPending}
          error={docs.error}
          onRetry={() => docs.refetch()}
          empty={<EmptyState icon={FileText} title="Nothing expiring soon" />}
          columns={[
            { key: 'who', header: 'Employee', cell: (d) => <Link href={`/employees/${d.employee.id}/documents`} className="font-medium hover:underline">{d.employee.name}</Link> },
            { key: 'title', header: 'Document', cell: (d) => `${d.title} · ${TYPES[d.type]}` },
            { key: 'expires', header: 'Expires', cell: (d) => <span className="inline-flex gap-2">{formatDate(d.expiresOn)}{d.expired ? <Badge tone="danger">Expired</Badge> : null}</span> },
          ]}
        />
      </Card>
    </>
  );
}
