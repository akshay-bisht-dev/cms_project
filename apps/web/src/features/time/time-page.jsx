'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Lock, Pencil, Plus, Timer, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { PageHeader } from '@/components/common/page-header';
import { EmptyState, ErrorState } from '@/components/common/states';
import { useCan, useMe } from '@/features/session/session-provider';
import { StatTile } from '@/features/dashboard/stat-tile';
import { api } from '@/lib/api';
import { addDays, formatDuration, formatTime, formatWeekday, todayIn, weekOf } from '@/lib/format';
import { queryKeys } from '@/lib/query-keys';
import { EntryDialog } from './entry-dialog';
import { useServerNow, useWorkState } from './use-work-state';

/** Local calendar date (YYYY-MM-DD) of an instant in a zone. */
const localDay = (iso, zone) => new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date(iso));

/** A week of time entries for me, or for an employee (profile tab) when `employeeId` is given. */
export function TimeEntriesWeek({ employeeId, title = 'My time' }) {
  const me = useMe();
  const queryClient = useQueryClient();
  const canManual = useCan('time.manual');
  const canEditOthers = useCan('time.edit.others');
  const zone = me.organization.timeZone;
  const [week, setWeek] = useState(() => weekOf(todayIn(zone), 1));
  const [dialog, setDialog] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const { data: ws } = useWorkState();
  const now = useServerNow(ws?.clockOffsetMs ?? 0, ws?.timer.state === 'RUNNING');
  const params = { ...week, ...(employeeId ? { employeeId } : {}) };
  const entries = useQuery({ queryKey: queryKeys.timeEntries(params), queryFn: () => api.get('/time-entries', { query: params }) });
  const tz = entries.data?.meta.timeZone ?? zone;
  const isSelf = !employeeId || employeeId === me.employeeId;
  const canEdit = isSelf ? canManual : canEditOthers;

  const remove = useMutation({
    mutationFn: (id) => api.delete(`/time-entries/${id}`, {}),
    onSuccess: () => {
      toast.success('Entry deleted');
      queryClient.invalidateQueries({ queryKey: ['time-entries'] });
    },
    onError: (error) => toast.error(error.message),
  });

  const duration = (e) => (e.running ? (now - Date.parse(e.startedAt)) / 1000 : e.durationS);
  const items = entries.data?.data ?? [];
  const days = [...Array(7)].map((_, i) => addDays(week.from, i)).reverse();
  const byDay = Object.fromEntries(days.map((d) => [d, items.filter((e) => localDay(e.startedAt, tz) === d)]));
  const total = items.reduce((s, e) => s + duration(e), 0);
  const billable = items.filter((e) => e.isBillable).reduce((s, e) => s + duration(e), 0);

  return (
    <>
      {!employeeId && (
        <PageHeader
          title={title}
          description={`Entries from your timer and manual additions. Times shown in ${tz}.`}
          actions={
            canManual && (
              <Button onClick={() => setDialog({ defaultDate: todayIn(tz) })}>
                <Plus aria-hidden /> Add time
              </Button>
            )
          }
        />
      )}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Button variant="outline" size="icon" aria-label="Previous week" onClick={() => setWeek({ from: addDays(week.from, -7), to: addDays(week.to, -7) })}>
          <ChevronLeft aria-hidden />
        </Button>
        <span className="min-w-56 text-center text-sm font-medium">
          {formatWeekday(week.from)} – {formatWeekday(week.to)}
        </span>
        <Button variant="outline" size="icon" aria-label="Next week" onClick={() => setWeek({ from: addDays(week.from, 7), to: addDays(week.to, 7) })}>
          <ChevronRight aria-hidden />
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setWeek(weekOf(todayIn(tz), 1))}>
          This week
        </Button>
      </div>
      <div className="mb-4 grid gap-4 sm:grid-cols-3">
        <StatTile label="Tracked" value={formatDuration(total)} basis="All entries this week" />
        <StatTile label="Billable" value={formatDuration(billable)} basis="Entries marked billable" />
        <StatTile label="Non-billable" value={formatDuration(total - billable)} basis="Tracked minus billable" />
      </div>
      <Card>
        {entries.isPending ? (
          <div className="space-y-3 p-4">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : entries.error ? (
          entries.error.status === 403 ? (
            <EmptyState icon={Timer} title="Time entries are restricted" description="You do not have permission to view this employee’s time." />
          ) : (
            <ErrorState error={entries.error} onRetry={() => entries.refetch()} />
          )
        ) : items.length === 0 ? (
          <EmptyState icon={Timer} title="No time tracked this week" description={isSelf ? 'Start the timer from the top bar, or add time manually.' : undefined} />
        ) : (
          <ol className="divide-y">
            {days
              .filter((d) => byDay[d].length)
              .map((day) => (
                <li key={day}>
                  <div className="flex items-center justify-between bg-muted/60 px-4 py-2 text-sm font-medium">
                    <span>{formatWeekday(day)}</span>
                    <span className="tabular-nums">{formatDuration(byDay[day].reduce((s, e) => s + duration(e), 0))}</span>
                  </div>
                  <ul className="divide-y">
                    {byDay[day].map((e) => (
                      <li key={e.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                        <span className="w-28 tabular-nums text-muted-foreground">
                          {formatTime(e.startedAt, tz)} – {e.running ? 'now' : formatTime(e.endedAt, tz)}
                        </span>
                        <span className="min-w-0 flex-1 truncate">
                          {e.task ? <span className="mr-2 text-xs text-muted-foreground">{e.task.key}</span> : e.project ? <span className="mr-2 text-xs text-muted-foreground">{e.project.code}</span> : null}
                          {e.description || e.task?.title || <span className="text-muted-foreground">No description</span>}
                        </span>
                        {e.isBillable && <Badge tone="info">Billable</Badge>}
                        {e.running && <Badge tone="success">Running</Badge>}
                        <span className="w-16 text-right font-medium tabular-nums">{formatDuration(duration(e))}</span>
                        {e.locked ? (
                          <Lock className="size-4 text-muted-foreground" aria-label="Locked by a submitted or approved timesheet" />
                        ) : (
                          canEdit &&
                          !e.running && (
                            <span className="flex gap-1">
                              <Button variant="ghost" size="icon" aria-label="Edit entry" onClick={() => setDialog({ entry: e })}>
                                <Pencil aria-hidden />
                              </Button>
                              <Button variant="ghost" size="icon" aria-label="Delete entry" onClick={() => setDeleting(e)}>
                                <Trash2 aria-hidden />
                              </Button>
                            </span>
                          )
                        )}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
          </ol>
        )}
      </Card>
      {dialog && <EntryDialog {...dialog} timeZone={tz} employeeId={isSelf ? undefined : employeeId} onClose={() => setDialog(null)} />}
      <AlertDialog open={Boolean(deleting)} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogTitle>Delete this entry?</AlertDialogTitle>
          <AlertDialogDescription>It no longer counts toward timesheets. The change is kept in the entry’s history.</AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction destructive onClick={() => remove.mutate(deleting.id)}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
