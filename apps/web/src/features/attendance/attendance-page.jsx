'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, ChevronLeft, ChevronRight, ClipboardCheck, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/input';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { PageHeader } from '@/components/common/page-header';
import { EmptyState, ErrorState } from '@/components/common/states';
import { DataTable } from '@/components/data-tables/data-table';
import { StatTile } from '@/features/dashboard/stat-tile';
import { useCan, useMe } from '@/features/session/session-provider';
import { useUrlState } from '@/hooks/use-url-state';
import { api } from '@/lib/api';
import { addDays, formatDate, formatDuration, formatTime, formatWeekday, todayIn } from '@/lib/format';
import { queryKeys } from '@/lib/query-keys';
import { cn } from '@/lib/utils';
import { CorrectionStatus, FlagBadges, PresenceBadge } from './attendance-badges';
import { CorrectionDialog } from './correction-dialog';

function monthRange(isoMonth) {
  const from = `${isoMonth}-01`;
  const next = new Date(`${from}T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return { from, to: addDays(next.toISOString().slice(0, 10), -1) };
}

/** A month of daily records for me, or for an employee in my scope (profile tab). */
export function AttendanceMonth({ employeeId }) {
  const me = useMe();
  const isSelf = !employeeId || employeeId === me.employeeId;
  const [month, setMonth] = useState(() => todayIn(me.organization.timeZone).slice(0, 7));
  const [dialog, setDialog] = useState(null);
  const range = monthRange(month);
  const params = { ...range, ...(employeeId ? { employeeId } : {}) };
  const records = useQuery({ queryKey: queryKeys.attendanceRecords(params), queryFn: () => api.get('/attendance/records', { query: params }) });
  const shiftMonth = (delta) => {
    const d = new Date(`${month}-01T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + delta);
    setMonth(d.toISOString().slice(0, 7));
  };
  const totals = records.data?.meta.totals;
  const zone = records.data?.data[0]?.timeZone ?? me.organization.timeZone;
  const monthLabel = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-01T00:00:00Z`));

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Button variant="outline" size="icon" aria-label="Previous month" onClick={() => shiftMonth(-1)}>
          <ChevronLeft aria-hidden />
        </Button>
        <span className="min-w-40 text-center text-sm font-medium">{monthLabel}</span>
        <Button variant="outline" size="icon" aria-label="Next month" onClick={() => shiftMonth(1)}>
          <ChevronRight aria-hidden />
        </Button>
        {isSelf && (
          <Button variant="outline" size="sm" className="ml-auto" onClick={() => setDialog({ kind: 'ADD', defaultDate: todayIn(zone) })}>
            <Plus aria-hidden /> Add missing time
          </Button>
        )}
      </div>
      <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Worked" value={totals ? formatDuration(totals.workedS) : null} basis="Closed sessions, breaks excluded" />
        <StatTile label="Overtime" value={totals ? formatDuration(totals.overtimeS) : null} basis="Beyond the scheduled hours" />
        <StatTile label="Late days" value={totals?.lateDays} basis="Arrived after the grace period" />
        <StatTile label="Absent days" value={totals?.absentDays} basis="Scheduled, no attendance" />
      </div>
      <Card>
        {records.isPending ? (
          <div className="space-y-3 p-4">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        ) : records.error ? (
          records.error.status === 403 ? (
            <EmptyState icon={CalendarClock} title="Attendance is restricted" description="You do not have permission to view this employee’s attendance." />
          ) : (
            <ErrorState error={records.error} onRetry={() => records.refetch()} />
          )
        ) : records.data.data.length === 0 ? (
          <EmptyState icon={CalendarClock} title="No attendance this month" />
        ) : (
          <ul className="divide-y">
            {records.data.data.map((r) => (
              <li key={r.id} className="grid gap-2 px-4 py-3 text-sm sm:grid-cols-[10rem_1fr_auto] sm:items-start">
                <div>
                  <p className="font-medium">{formatWeekday(r.workDate)}</p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    <PresenceBadge value={r.status} />
                    <FlagBadges flags={r.flags} />
                  </div>
                </div>
                <ul className="grid gap-1">
                  {r.sessions.map((s) => (
                    <li key={s.id} className="flex flex-wrap items-center gap-2">
                      <span className="tabular-nums">
                        {formatTime(s.startedAt, r.timeZone)} – {s.endedAt ? formatTime(s.endedAt, r.timeZone) : 'now'}
                      </span>
                      {s.breaks.length > 0 && <span className="text-xs text-muted-foreground">{s.breaks.length} break{s.breaks.length > 1 ? 's' : ''}</span>}
                      {s.endReason === 'AUTO_CLOSED' && <span className="text-xs text-warning">auto-closed</span>}
                      {isSelf && s.endedAt && (
                        <span className="flex gap-1">
                          <button type="button" className="text-xs text-primary hover:underline" onClick={() => setDialog({ kind: 'MODIFY', session: s })}>
                            Fix times
                          </button>
                          <button type="button" className="text-xs text-primary hover:underline" onClick={() => setDialog({ kind: 'DELETE', session: s })}>
                            Remove
                          </button>
                        </span>
                      )}
                    </li>
                  ))}
                  {r.lateByS > 0 && <li className="text-xs text-warning">Late by {formatDuration(r.lateByS)}</li>}
                </ul>
                <p className="font-medium tabular-nums sm:text-right">{formatDuration(r.workedS)}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {dialog && <CorrectionDialog {...dialog} timeZone={zone} onClose={() => setDialog(null)} />}
    </>
  );
}

function TeamBoard() {
  const me = useMe();
  const zone = me.organization.timeZone;
  const board = useQuery({ queryKey: queryKeys.attendanceBoard, queryFn: async () => (await api.get('/attendance/board')).data, refetchInterval: 60_000 });
  const columns = [
    {
      key: 'name',
      header: 'Employee',
      cell: (r) => (
        <Link href={`/employees/${r.employeeId}/attendance`} className="font-medium hover:underline">
          {r.name}
          <span className="block text-xs font-normal text-muted-foreground">{r.designation ?? ''}</span>
        </Link>
      ),
    },
    { key: 'presence', header: 'Status', cell: (r) => <PresenceBadge value={r.presence} /> },
    { key: 'in', header: `First in (${zone})`, cell: (r) => (r.firstInAt ? formatTime(r.firstInAt, zone) : '—'), className: 'hidden sm:table-cell' },
    { key: 'late', header: 'Late by', cell: (r) => (r.lateByS ? formatDuration(r.lateByS) : '—'), className: 'hidden md:table-cell' },
  ];
  const counts = board.data?.counts ?? {};
  return (
    <>
      <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Working" value={board.data ? (counts.WORKING ?? 0) : null} basis="Clocked in now" />
        <StatTile label="On break" value={board.data ? (counts.ON_BREAK ?? 0) : null} basis="On a break now" />
        <StatTile label="Absent" value={board.data ? (counts.ABSENT ?? 0) : null} basis="Scheduled, not clocked in yet" />
        <StatTile label="Done for the day" value={board.data ? (counts.CLOCKED_OUT ?? 0) : null} basis="Clocked out today" />
      </div>
      <Card>
        <DataTable
          caption="Team presence"
          columns={columns}
          rows={board.data?.items ?? []}
          rowKey="employeeId"
          isPending={board.isPending}
          error={board.error}
          onRetry={() => board.refetch()}
          empty={<EmptyState title="No one in your scope" />}
        />
      </Card>
    </>
  );
}

function ReviewDialog({ correction, decision, onClose }) {
  const queryClient = useQueryClient();
  const [comment, setComment] = useState('');
  const mutation = useMutation({
    mutationFn: () => api.post(`/attendance/corrections/${correction.id}/${decision}`, comment ? { comment } : {}),
    onSuccess: () => {
      toast.success(decision === 'approve' ? 'Correction approved' : 'Correction rejected');
      queryClient.invalidateQueries({ queryKey: ['attendance'] });
      onClose();
    },
    onError: (error) => toast.error(error.details?.[0]?.message ?? error.message),
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{decision === 'approve' ? 'Approve' : 'Reject'} correction</DialogTitle>
        </DialogHeader>
        <label className="grid gap-1.5 text-sm font-medium">
          {decision === 'approve' ? 'Comment (optional)' : 'Reason (required)'}
          <Textarea value={comment} onChange={(e) => setComment(e.target.value)} maxLength={500} />
        </label>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={decision === 'approve' ? 'default' : 'destructive'} disabled={mutation.isPending || (decision === 'reject' && !comment.trim())} onClick={() => mutation.mutate()}>
            {decision === 'approve' ? 'Approve' : 'Reject'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Corrections() {
  const queryClient = useQueryClient();
  const canReview = useCan('attendance.correct.approve');
  const [reviewing, setReviewing] = useState(null);
  const mine = useQuery({ queryKey: queryKeys.corrections({ mine: true }), queryFn: async () => (await api.get('/attendance/corrections', { query: { mine: true } })).data });
  const toReview = useQuery({
    queryKey: queryKeys.corrections({ mine: false }),
    queryFn: async () => (await api.get('/attendance/corrections', { query: { mine: false, status: 'PENDING' } })).data,
    enabled: canReview,
  });
  const cancel = useMutation({
    mutationFn: (id) => api.post(`/attendance/corrections/${id}/cancel`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['attendance'] }),
    onError: (error) => toast.error(error.message),
  });
  const describe = (c) =>
    c.kind === 'DELETE'
      ? 'Remove session'
      : `${c.kind === 'ADD' ? 'Add' : 'Change to'} ${formatTime(c.proposedStartAt)} – ${formatTime(c.proposedEndAt)}`;

  return (
    <div className="grid gap-4">
      {canReview && (
        <Card>
          <CardHeader>
            <CardTitle>Waiting for your review</CardTitle>
          </CardHeader>
          <CardContent>
            {toReview.isPending ? (
              <Skeleton className="h-16" />
            ) : toReview.data?.length ? (
              <ul className="divide-y">
                {toReview.data.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">
                        {c.employee?.name} · {formatDate(c.workDate)}
                      </p>
                      <p className="text-muted-foreground">
                        {describe(c)}: “{c.reason}”
                      </p>
                    </div>
                    <Button size="sm" onClick={() => setReviewing({ correction: c, decision: 'approve' })}>
                      Approve
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setReviewing({ correction: c, decision: 'reject' })}>
                      Reject
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState icon={ClipboardCheck} title="Nothing to review" />
            )}
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle>My requests</CardTitle>
        </CardHeader>
        <CardContent>
          {mine.isPending ? (
            <Skeleton className="h-16" />
          ) : mine.data?.length ? (
            <ul className="divide-y">
              {mine.data.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{formatDate(c.workDate)}</p>
                    <p className="text-muted-foreground">{describe(c)}</p>
                    {c.reviewComment && <p className="text-xs text-muted-foreground">Reviewer: {c.reviewComment}</p>}
                  </div>
                  <CorrectionStatus status={c.status} />
                  {c.status === 'PENDING' && (
                    <Button size="sm" variant="ghost" onClick={() => cancel.mutate(c.id)}>
                      Cancel
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-4 text-sm text-muted-foreground">You have not requested any corrections.</p>
          )}
        </CardContent>
      </Card>
      {reviewing && <ReviewDialog {...reviewing} onClose={() => setReviewing(null)} />}
    </div>
  );
}

export function AttendancePage() {
  const canBoard = useCan('attendance.read');
  const me = useMe();
  const seesOthers = canBoard && me.permissions.find((p) => p.key === 'attendance.read')?.scopes.some((s) => s !== 'self');
  const tabs = [
    { id: 'mine', label: 'My attendance' },
    ...(seesOthers ? [{ id: 'team', label: 'Team' }] : []),
    { id: 'corrections', label: 'Corrections' },
  ];
  const [{ tab }, setTab] = useUrlState({ tab: 'mine' });
  const active = tabs.some((t) => t.id === tab) ? tab : 'mine';
  return (
    <>
      <PageHeader title="Attendance" description="Clock-in records, breaks and corrections. Times follow each person’s time zone." />
      <div role="tablist" aria-label="Attendance views" className="mb-4 flex gap-1 border-b">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={active === t.id}
            onClick={() => setTab({ tab: t.id })}
            className={cn('h-10 border-b-2 px-3 text-sm', active === t.id ? 'border-primary font-medium text-primary' : 'border-transparent text-muted-foreground hover:text-foreground')}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {active === 'mine' && <AttendanceMonth />}
        {active === 'team' && <TeamBoard />}
        {active === 'corrections' && <Corrections />}
      </div>
    </>
  );
}
