'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileText, Play } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, NativeSelect } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { PageHeader } from '@/components/common/page-header';
import { EmptyState, ErrorState } from '@/components/common/states';
import { useTeams } from '@/features/employees/queries';
import { useMe } from '@/features/session/session-provider';
import { api } from '@/lib/api';
import { addDays, formatDate, todayIn } from '@/lib/format';
import { cn } from '@/lib/utils';
import { KIND_HINT, KIND_LABEL, formatMetric } from '@/features/activity/metrics';
import { activityKeys } from '@/features/activity/queries';

const GROUP_LABEL = { member: 'Employee', project: 'Project', day: 'Day' };
const JOB_TONE = { QUEUED: 'info', RUNNING: 'info', COMPLETED: 'success', FAILED: 'danger', EXPIRED: 'neutral' };

function ResultTable({ result }) {
  const numeric = (c) => c.type !== 'text';
  return (
    <div className="grid gap-3">
      <Table scrollLabel={`${result.title} results`}>
          <caption className="sr-only">{result.title}</caption>
          <TableHeader>
            <tr>
              {result.columns.map((c) => (
                <TableHead key={c.key} className={cn(numeric(c) && 'text-right')}>
                  <span className="block">{c.label}</span>
                  {c.kind ? <span className="block text-[11px] font-normal text-muted-foreground">{KIND_LABEL[c.kind]}</span> : null}
                </TableHead>
              ))}
            </tr>
          </TableHeader>
          <TableBody>
            {result.rows.map((r, i) => (
              <TableRow key={`${r.label}-${i}`}>
                {result.columns.map((c) => (
                  <TableCell key={c.key} className={cn(numeric(c) ? 'text-right tabular-nums' : 'font-medium whitespace-nowrap')}>
                    {formatMetric(r[c.key], c.type)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
            {result.totals ? (
              <TableRow className="border-t-2 font-semibold">
                {result.columns.map((c, i) => (
                  <TableCell key={c.key} className={cn(numeric(c) && 'text-right tabular-nums')}>
                    {i === 0 ? 'Total' : formatMetric(result.totals[c.key], c.type)}
                  </TableCell>
                ))}
              </TableRow>
            ) : null}
          </TableBody>
      </Table>
      <ul className="space-y-1 text-xs text-muted-foreground">
        <li>Measured: {KIND_HINT.measured} Derived: {KIND_HINT.derived}</li>
        {result.meta.notes.map((n) => <li key={n}>{n}</li>)}
      </ul>
    </div>
  );
}

function Exports() {
  const jobs = useQuery({
    queryKey: activityKeys.jobs,
    queryFn: async () => (await api.get('/reports/jobs')).data,
    refetchInterval: (q) => ((q.state.data ?? []).some((j) => ['QUEUED', 'RUNNING'].includes(j.status)) ? 3000 : false),
  });
  async function download(job) {
    try {
      const { data } = await api.get(`/reports/jobs/${job.id}/download`);
      window.location.assign(data.url);
    } catch (error) {
      toast.error(error.message);
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>My exports</CardTitle>
        <CardDescription>Files are kept for 7 days. Access is checked again when you download.</CardDescription>
      </CardHeader>
      <CardContent>
        {jobs.isPending ? (
          <Skeleton className="h-16" />
        ) : jobs.error ? (
          <ErrorState error={jobs.error} />
        ) : jobs.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">No exports yet.</p>
        ) : (
          <ul className="divide-y">
            {jobs.data.map((j) => (
              <li key={j.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                <FileText aria-hidden className="size-4 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  {j.title} · {j.params.from} to {j.params.to} · {j.format.toUpperCase()}
                  <span className="block text-xs text-muted-foreground">{j.error ?? `Requested ${formatDate(j.createdAt, { withTime: true })}`}</span>
                </span>
                <Badge tone={JOB_TONE[j.status]}>{j.status === 'QUEUED' ? 'Queued' : j.status.charAt(0) + j.status.slice(1).toLowerCase()}</Badge>
                {j.status === 'COMPLETED' ? (
                  <Button size="sm" variant="outline" onClick={() => download(j)}>
                    <Download aria-hidden /> Download
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function ReportsPage() {
  const me = useMe();
  const queryClient = useQueryClient();
  const today = todayIn(me.organization.timeZone);
  const teams = useTeams();
  const catalog = useQuery({ queryKey: activityKeys.reports, queryFn: async () => (await api.get('/reports')).data });
  const [type, setType] = useState(null);
  const [form, setForm] = useState({ from: addDays(today, -6), to: today, groupBy: '', teamId: '' });
  const [submitted, setSubmitted] = useState(null);

  const def = catalog.data?.find((r) => r.type === (type ?? catalog.data?.[0]?.type));
  const params = (f) => ({ from: f.from, to: f.to, groupBy: f.groupBy || def.groupBy[0], ...(f.teamId ? { teamId: f.teamId } : {}) });
  const result = useQuery({
    queryKey: activityKeys.report(submitted?.type, submitted?.params),
    queryFn: async () => (await api.get(`/reports/${submitted.type}`, { query: submitted.params })).data,
    enabled: Boolean(submitted),
  });
  const exportJob = useMutation({
    mutationFn: (format) => api.post('/reports/jobs', { type: def.type, format, params: params(form) }, { idempotencyKey: crypto.randomUUID() }),
    onSuccess: () => {
      toast.success('Export started. It appears below when it is ready.');
      queryClient.invalidateQueries({ queryKey: activityKeys.jobs });
    },
    onError: (error) => toast.error(error.details?.[0]?.message ?? error.message),
  });

  if (catalog.isPending) return <Skeleton className="h-96" role="status" aria-label="Loading reports" />;
  if (catalog.error) return <ErrorState error={catalog.error} onRetry={() => catalog.refetch()} />;
  if (!catalog.data.length) return <EmptyState title="No reports available" description="You do not have access to any reports." />;

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <>
      <PageHeader title="Reports" description="Data limited to the people and projects you can see. Up to 31 days on screen; longer ranges as an export." />
      <div className="grid gap-6 lg:grid-cols-[16rem_1fr]">
        <nav aria-label="Reports" className="grid content-start gap-2">
          {catalog.data.map((r) => (
            <button
              key={r.type}
              type="button"
              aria-current={def.type === r.type ? 'true' : undefined}
              onClick={() => (setType(r.type), setSubmitted(null), setForm((f) => ({ ...f, groupBy: '' })))}
              className={cn('rounded-lg border p-3 text-left text-sm', def.type === r.type ? 'border-primary bg-secondary' : 'bg-card hover:bg-muted')}
            >
              <span className="block font-medium">{r.title}</span>
              <span className="block text-xs text-muted-foreground">{r.description}</span>
            </button>
          ))}
        </nav>
        <div className="grid min-w-0 content-start gap-6">
          <Card>
            <CardHeader>
              <CardTitle>{def.title}</CardTitle>
              <CardDescription>{def.description}</CardDescription>
            </CardHeader>
            <CardContent>
              <form className="flex flex-wrap items-end gap-4" onSubmit={(e) => (e.preventDefault(), setSubmitted({ type: def.type, params: params(form) }))}>
                <label className="grid gap-1.5 text-sm font-medium">From<Input type="date" required value={form.from} onChange={set('from')} /></label>
                <label className="grid gap-1.5 text-sm font-medium">To<Input type="date" required value={form.to} onChange={set('to')} /></label>
                <label className="grid gap-1.5 text-sm font-medium">
                  Group by
                  <NativeSelect value={form.groupBy || def.groupBy[0]} onChange={set('groupBy')}>
                    {def.groupBy.map((g) => <option key={g} value={g}>{GROUP_LABEL[g]}</option>)}
                  </NativeSelect>
                </label>
                <label className="grid gap-1.5 text-sm font-medium">
                  Team
                  <NativeSelect value={form.teamId} onChange={set('teamId')}>
                    <option value="">Everyone in my scope</option>
                    {(teams.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </NativeSelect>
                </label>
                <Button type="submit"><Play aria-hidden /> Run</Button>
                {def.canExport ? (
                  <span className="flex gap-2">
                    <Button type="button" variant="outline" disabled={exportJob.isPending} onClick={() => exportJob.mutate('csv')}>Export CSV</Button>
                    <Button type="button" variant="outline" disabled={exportJob.isPending} onClick={() => exportJob.mutate('pdf')}>Export PDF</Button>
                  </span>
                ) : null}
              </form>
            </CardContent>
          </Card>
          {submitted ? (
            <Card>
              <CardContent className="pt-6">
                {result.isPending ? (
                  <Skeleton className="h-48" role="status" aria-label="Running report" />
                ) : result.error ? (
                  <ErrorState error={result.error} onRetry={() => result.refetch()} />
                ) : result.data.rows.length === 0 ? (
                  <EmptyState title="Nothing to report" description="No data for this period and scope." />
                ) : (
                  <ResultTable result={result.data} />
                )}
              </CardContent>
            </Card>
          ) : null}
          {def.canExport ? <Exports /> : null}
        </div>
      </div>
    </>
  );
}
