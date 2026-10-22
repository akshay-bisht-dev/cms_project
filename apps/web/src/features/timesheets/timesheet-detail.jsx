'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileText } from 'lucide-react';
import { toast } from 'sonner';
import { API_PREFIX } from '@orbit/shared-constants';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState, ErrorState } from '@/components/common/states';
import { StatTile } from '@/features/dashboard/stat-tile';
import { api } from '@/lib/api';
import { formatDate, formatDuration, formatTime, formatWeekday } from '@/lib/format';
import { queryKeys } from '@/lib/query-keys';
import { TimesheetStatus } from './timesheet-badges';

const ACTION_LABEL = { SUBMIT: 'Submitted', APPROVE: 'Approved', REJECT: 'Returned', REOPEN: 'Reopened' };

function DecisionDialog({ sheet, action, onClose }) {
  const queryClient = useQueryClient();
  const [comment, setComment] = useState('');
  const [key] = useState(() => crypto.randomUUID());
  const requiresComment = action === 'reject';
  const mutation = useMutation({
    mutationFn: () => api.post(`/timesheets/${sheet.id}/${action}`, comment ? { comment } : {}, action === 'reopen' ? {} : { idempotencyKey: key }),
    onSuccess: () => {
      toast.success({ approve: 'Timesheet approved', reject: 'Timesheet returned for changes', reopen: 'Timesheet reopened' }[action]);
      queryClient.invalidateQueries({ queryKey: ['timesheets'] });
      queryClient.invalidateQueries({ queryKey: ['timesheet'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      onClose();
    },
    onError: (error) => toast.error(error.details?.[0]?.message ?? error.message),
  });
  const titles = { approve: 'Approve timesheet', reject: 'Return for changes', reopen: 'Reopen approved timesheet' };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{titles[action]}</DialogTitle>
          <DialogDescription>
            {sheet.employee?.name} · {formatDuration(sheet.totalS)} tracked
          </DialogDescription>
        </DialogHeader>
        <label className="grid gap-1.5 text-sm font-medium">
          {requiresComment ? 'What needs to change? (required)' : 'Comment (optional)'}
          <Textarea value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000} />
        </label>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={action === 'approve' ? 'default' : 'destructive'} disabled={mutation.isPending || (requiresComment && !comment.trim())} onClick={() => mutation.mutate()}>
            {titles[action].split(' ')[0]}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function TimesheetDetail({ timesheetId }) {
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState(null);
  const sheet = useQuery({ queryKey: queryKeys.timesheet(timesheetId), queryFn: async () => (await api.get(`/timesheets/${timesheetId}`)).data });
  const submit = useMutation({
    mutationFn: () => api.post(`/timesheets/${timesheetId}/submit`, undefined, { idempotencyKey: crypto.randomUUID() }),
    onSuccess: () => {
      toast.success('Timesheet submitted for approval');
      queryClient.invalidateQueries({ queryKey: ['timesheet'] });
      queryClient.invalidateQueries({ queryKey: ['timesheets'] });
    },
    onError: (error) => toast.error(error.message),
  });

  if (sheet.isPending) return <Skeleton className="h-96" />;
  if (sheet.error) return sheet.error.status === 404 ? <EmptyState title="Timesheet not found" /> : <ErrorState error={sheet.error} onRetry={() => sheet.refetch()} />;
  const t = sheet.data;
  const exportHref = (format) => `${API_PREFIX}/timesheets/${t.id}/export?format=${format}`;
  const byDay = t.entries.reduce((acc, e) => {
    const day = new Intl.DateTimeFormat('en-CA').format(new Date(e.startedAt));
    (acc[day] ??= []).push(e);
    return acc;
  }, {});

  return (
    <>
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold">Timesheet · {t.employee?.name}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            {formatDate(t.periodStart)} – {formatDate(t.periodEnd)} <TimesheetStatus status={t.status} />
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" asChild>
            <a href={exportHref('csv')} download>
              <Download aria-hidden /> CSV
            </a>
          </Button>
          <Button variant="outline" asChild>
            <a href={exportHref('pdf')} download>
              <FileText aria-hidden /> PDF
            </a>
          </Button>
          {t.actions.canSubmit && (
            <Button onClick={() => submit.mutate()} disabled={submit.isPending || t.totalS === 0}>
              Submit for approval
            </Button>
          )}
          {t.actions.canDecide && (
            <>
              <Button variant="outline" onClick={() => setDialog('reject')}>
                Return for changes
              </Button>
              <Button onClick={() => setDialog('approve')}>Approve</Button>
            </>
          )}
          {t.actions.canReopen && (
            <Button variant="outline" onClick={() => setDialog('reopen')}>
              Reopen
            </Button>
          )}
        </div>
      </div>
      <div className="mb-4 grid gap-4 sm:grid-cols-3">
        <StatTile label="Total" value={formatDuration(t.totalS)} basis={`${t.entries.length} entries`} />
        <StatTile label="Billable" value={formatDuration(t.billableS)} basis="Marked billable" />
        <StatTile label="Non-billable" value={formatDuration(t.totalS - t.billableS)} basis="Total minus billable" />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Entries</CardTitle>
          </CardHeader>
          <CardContent>
            {t.entries.length === 0 ? (
              <p className="text-sm text-muted-foreground">No completed entries in this period.</p>
            ) : (
              <ol className="divide-y">
                {Object.entries(byDay).map(([day, list]) => (
                  <li key={day} className="py-2">
                    <p className="flex justify-between text-sm font-medium">
                      <span>{formatWeekday(day)}</span>
                      <span className="tabular-nums">{formatDuration(list.reduce((s, e) => s + e.durationS, 0))}</span>
                    </p>
                    <ul className="mt-1 grid gap-1">
                      {list.map((e) => (
                        <li key={e.id} className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                          <span className="w-28 tabular-nums">
                            {formatTime(e.startedAt)} – {formatTime(e.endedAt)}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-foreground">{e.description || 'No description'}</span>
                          {e.isBillable && <Badge tone="info">Billable</Badge>}
                          <span className="tabular-nums">{formatDuration(e.durationS)}</span>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>History</CardTitle>
          </CardHeader>
          <CardContent>
            {t.history.length === 0 ? (
              <p className="text-sm text-muted-foreground">Not submitted yet.</p>
            ) : (
              <ol className="grid gap-3">
                {t.history.map((h, i) => (
                  <li key={i} className="text-sm">
                    <p>
                      <span className="font-medium">{ACTION_LABEL[h.action]}</span> by {h.actor?.name ?? 'someone'}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatDate(h.createdAt, { withTime: true })} · {formatDuration(h.snapshot.totalS)}
                    </p>
                    {h.comment && <p className="mt-1 rounded bg-muted p-2 text-xs">{h.comment}</p>}
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
      </div>
      {dialog && <DecisionDialog sheet={t} action={dialog} onClose={() => setDialog(null)} />}
    </>
  );
}
