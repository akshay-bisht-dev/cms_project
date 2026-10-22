'use client';

import { useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ACTIVITY_TYPES } from '@orbit/shared-constants';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ChevronLeft, ChevronRight, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, NativeSelect } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/common/page-header';
import { EmptyState, ErrorState } from '@/components/common/states';
import { DataTable } from '@/components/data-tables/data-table';
import { useEmployees } from '@/features/employees/queries';
import { useMe } from '@/features/session/session-provider';
import { addDays, formatDuration, formatTime, todayIn, weekOf } from '@/lib/format';
import { cn } from '@/lib/utils';
import { KIND_HINT, STATUS_LABEL, formatPercent } from './metrics';
import { useActivityDay, useActivityWeek, useTeamDay } from './queries';

/** A headline figure with how it was obtained (FR-ACT-3). */
export function Metric({ label, value, kind, basis }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value ?? '—'}</p>
      <p className="mt-1 text-xs text-muted-foreground">
        <span className="font-medium">{kind === 'derived' ? 'Derived' : 'Measured'}</span>
        {basis ? ` · ${basis}` : ''}
      </p>
    </div>
  );
}

const HOUR = 3600_000;

/** Lanes over the local day: at work, breaks, timer (billable or not) and idle time. */
function DayTimeline({ day }) {
  const start = new Date(day.window.start).getTime();
  const end = new Date(day.window.end).getTime();
  // Open sessions and timers are drawn up to the moment the day was loaded.
  const [now] = useState(() => Date.now());
  const span = end - start;
  const pos = (a, b) => {
    const s = Math.max(start, new Date(a).getTime());
    const e = Math.min(end, b ? new Date(b).getTime() : Math.min(now, end));
    return { left: `${((s - start) / span) * 100}%`, width: `${Math.max(0.3, ((e - s) / span) * 100)}%`, s, e };
  };
  const lanes = [
    { label: 'At work', items: day.sessions.map((s) => ({ ...pos(s.startedAt, s.endedAt), className: 'bg-success/70', title: 'At work' })) },
    { label: 'Breaks', items: day.sessions.flatMap((s) => s.breaks.map((b) => ({ ...pos(b.startedAt, b.endedAt ?? s.endedAt), className: 'bg-warning/70', title: 'Break' }))) },
    {
      label: 'Timer',
      items: day.timeEntries.map((e) => ({
        ...pos(e.startedAt, e.endedAt),
        className: e.isBillable ? 'bg-[var(--series-1)]' : 'bg-[var(--series-2)]',
        title: `${e.project ? `${e.project.code} · ` : ''}${e.description ?? 'Timer'}${e.isBillable ? ' (billable)' : ''}`,
      })),
    },
    ...(day.includesMonitoring
      ? [{ label: 'No input', items: day.events.filter((e) => e.type === 'agent.idle').map((e) => ({ ...pos(e.at, new Date(new Date(e.at).getTime() + e.durationS * 1000)), className: 'bg-muted-foreground/50', title: 'No keyboard or mouse input' })) }]
      : []),
  ];
  const ticks = [];
  for (let t = start; t <= end; t += 3 * HOUR) ticks.push(t);
  return (
    <figure className="grid gap-2">
      <div aria-hidden className="grid gap-2">
        {lanes.map((lane) => (
          <div key={lane.label} className="grid grid-cols-[5.5rem_1fr] items-center gap-2">
            <span className="text-xs text-muted-foreground">{lane.label}</span>
            <div className="relative h-5 rounded bg-muted">
              {lane.items.map((item, i) => (
                <span key={i} title={`${item.title}: ${formatTime(item.s, day.timeZone)}–${formatTime(item.e, day.timeZone)}`} className={cn('absolute inset-y-0 rounded-sm ring-1 ring-card', item.className)} style={{ left: item.left, width: item.width }} />
              ))}
            </div>
          </div>
        ))}
        <div className="relative ml-[6rem] h-4 text-[11px] text-muted-foreground">
          {ticks.map((t) => (
            <span key={t} className="absolute -translate-x-1/2" style={{ left: `${((t - start) / span) * 100}%` }}>
              {formatTime(t, day.timeZone)}
            </span>
          ))}
        </div>
      </div>
      <figcaption className="flex flex-wrap gap-4 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-[var(--series-1)]" /> Billable timer</span>
        <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-[var(--series-2)]" /> Non-billable timer</span>
        <span>Times in {day.timeZone}</span>
      </figcaption>
    </figure>
  );
}

function DayView({ employeeId, date, onDate }) {
  const day = useActivityDay({ employeeId, date });
  const d = day.data;
  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-2">
        <Button size="icon" variant="outline" aria-label="Previous day" onClick={() => onDate(addDays(date, -1))}><ChevronLeft aria-hidden /></Button>
        <Input type="date" aria-label="Day" value={date} onChange={(e) => e.target.value && onDate(e.target.value)} className="w-auto" />
        <Button size="icon" variant="outline" aria-label="Next day" onClick={() => onDate(addDays(date, 1))}><ChevronRight aria-hidden /></Button>
      </div>
      {day.isPending ? (
        <Skeleton className="h-64" role="status" aria-label="Loading day" />
      ) : day.error ? (
        <ErrorState error={day.error} onRetry={() => day.refetch()} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Metric label="Worked" value={formatDuration(d.stats?.workedS)} kind="measured" basis={d.stats?.scheduledS ? `of ${formatDuration(d.stats.scheduledS)} scheduled` : 'nothing scheduled'} />
            <Metric label="Tracked" value={formatDuration(d.stats?.trackedS)} kind="measured" basis={`${formatDuration(d.stats?.billableS)} billable`} />
            <Metric label="Breaks" value={formatDuration(d.stats?.breakS)} kind="measured" />
            {d.includesMonitoring ? (
              <Metric label="Screenshots" value={`${d.stats?.screenshotsOk ?? 0} / ${d.stats?.screenshotsExpected ?? 0}`} kind="derived" basis="received / expected while monitored" />
            ) : (
              <Metric label="Tasks completed" value={d.stats?.tasksCompleted ?? 0} kind="measured" />
            )}
          </div>
          <Card>
            <CardHeader>
              <CardTitle>{d.employee.name} · {STATUS_LABEL[d.stats?.status] ?? '—'}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-6">
              {d.sessions.length || d.timeEntries.length ? <DayTimeline day={d} /> : <EmptyState title="Nothing recorded" description="No work sessions or tracked time on this day." />}
              {d.byProject.length ? (
                <div className="grid gap-2">
                  <h3 className="text-sm font-medium">Tracked by project</h3>
                  <ul className="grid gap-1.5 text-sm">
                    {d.byProject.map((p) => (
                      <li key={p.project?.id ?? 'none'} className="flex justify-between gap-2">
                        <span>{p.project ? `${p.project.code} · ${p.project.name}` : 'No project'}</span>
                        <span className="tabular-nums text-muted-foreground">{formatDuration(p.trackedS)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <div className="grid gap-2">
                <h3 className="text-sm font-medium">What happened</h3>
                {d.events.length ? (
                  <ol className="grid gap-1 text-sm">
                    {d.events.map((e) => (
                      <li key={e.id} className="grid grid-cols-[4.5rem_1fr] gap-2">
                        <span className="tabular-nums text-muted-foreground">{formatTime(e.at, d.timeZone)}</span>
                        <span>
                          {ACTIVITY_TYPES[e.type] ?? e.type}
                          {e.durationS ? ` (${formatDuration(e.durationS)})` : ''}
                          {e.project ? <span className="text-muted-foreground"> · {e.project.code}</span> : null}
                        </span>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="text-sm text-muted-foreground">No events.</p>
                )}
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function WeekTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  return (
    <div className="rounded-md border bg-card px-3 py-2 text-xs shadow-md">
      <p className="font-medium">{row.label}</p>
      <p>Worked {formatDuration(row.workedS)}</p>
      <p>Tracked {formatDuration(row.trackedS)}</p>
    </div>
  );
}

function WeekView({ employeeId, date, onDate }) {
  const me = useMe();
  const weekStart = weekOf(date, me.organization.weekStart ?? 1).from;
  const week = useActivityWeek({ employeeId, weekStart });
  const data = useMemo(
    () => (week.data?.days ?? []).map((d) => ({ ...d, label: new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${d.date}T00:00:00Z`)), worked: (d.workedS ?? 0) / 3600, tracked: (d.trackedS ?? 0) / 3600 })),
    [week.data],
  );
  const s = week.data?.summary;
  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-2">
        <Button size="icon" variant="outline" aria-label="Previous week" onClick={() => onDate(addDays(weekStart, -7))}><ChevronLeft aria-hidden /></Button>
        <span className="text-sm font-medium">Week of {weekStart}</span>
        <Button size="icon" variant="outline" aria-label="Next week" onClick={() => onDate(addDays(weekStart, 7))}><ChevronRight aria-hidden /></Button>
      </div>
      {week.isPending ? (
        <Skeleton className="h-72" role="status" aria-label="Loading week" />
      ) : week.error ? (
        <ErrorState error={week.error} onRetry={() => week.refetch()} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Metric label="Worked" value={formatDuration(s.workedS)} kind="measured" basis={`${s.presentDays} ${s.presentDays === 1 ? 'day' : 'days'} present`} />
            <Metric label="Tracked" value={formatDuration(s.trackedS)} kind="measured" basis={`${formatDuration(s.billableS)} billable`} />
            <Metric label="Billable utilization" value={formatPercent(s.utilization)} kind="derived" basis="billable ÷ scheduled time" />
            <Metric label="Attendance" value={formatPercent(s.attendanceRate)} kind="derived" basis={`present on ${s.scheduledDays} scheduled days`} />
          </div>
          <Card>
            <CardHeader>
              <CardTitle>Worked and tracked per day</CardTitle>
              <CardDescription>Hours. Worked is time clocked in minus breaks; tracked is timer and manual entries.</CardDescription>
            </CardHeader>
            <CardContent>
              <figure>
                <div className="h-64" aria-hidden>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data} margin={{ top: 4, right: 8, bottom: 4, left: -16 }} barGap={2} accessibilityLayer={false}>
                      <CartesianGrid vertical={false} stroke="var(--border)" />
                      <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: 'var(--muted-foreground)', fontSize: 12 }} />
                      <YAxis tickLine={false} axisLine={false} allowDecimals={false} tick={{ fill: 'var(--muted-foreground)', fontSize: 12 }} />
                      <Tooltip content={<WeekTooltip />} cursor={{ fill: 'var(--muted)' }} />
                      <Legend verticalAlign="top" align="right" iconType="square" wrapperStyle={{ fontSize: 12, color: 'var(--foreground)' }} />
                      <Bar name="Worked" dataKey="worked" fill="var(--series-1)" radius={[4, 4, 0, 0]} maxBarSize={22} isAnimationActive={false} />
                      <Bar name="Tracked" dataKey="tracked" fill="var(--series-2)" radius={[4, 4, 0, 0]} maxBarSize={22} isAnimationActive={false} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <table className="sr-only">
                  <caption>Worked and tracked time per day</caption>
                  <thead><tr><th scope="col">Day</th><th scope="col">Worked</th><th scope="col">Tracked</th></tr></thead>
                  <tbody>{data.map((d) => <tr key={d.date}><td>{d.date}</td><td>{formatDuration(d.workedS)}</td><td>{formatDuration(d.trackedS)}</td></tr>)}</tbody>
                </table>
              </figure>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

const STATE_TONE = { WORKING: ['success', 'Working'], ON_BREAK: ['warning', 'On break'], OFF: ['neutral', 'Off'] };

function TeamView({ date, onDate }) {
  const team = useTeamDay({ date });
  return (
    <div className="grid gap-4">
      <Input type="date" aria-label="Day" value={date} onChange={(e) => e.target.value && onDate(e.target.value)} className="w-auto justify-self-start" />
      <Card>
        <DataTable
          caption="Team overview"
          rowKey="key"
          isPending={team.isPending}
          error={team.error}
          onRetry={() => team.refetch()}
          rows={(team.data?.members ?? []).map((m) => ({ ...m, key: m.employee.id }))}
          empty={<EmptyState title="Nobody in scope" />}
          columns={[
            { key: 'name', header: 'Employee', cell: (m) => <span className="font-medium">{m.employee.name}</span> },
            { key: 'state', header: 'Now', cell: (m) => <Badge tone={STATE_TONE[m.state][0]}>{STATE_TONE[m.state][1]}{m.timerRunning ? ' · timer' : ''}</Badge> },
            { key: 'status', header: 'Day', cell: (m) => STATUS_LABEL[m.stats?.status] ?? '—', className: 'hidden sm:table-cell' },
            { key: 'worked', header: 'Worked', cell: (m) => formatDuration(m.stats?.workedS), className: 'text-right tabular-nums' },
            { key: 'tracked', header: 'Tracked', cell: (m) => formatDuration(m.stats?.trackedS), className: 'text-right tabular-nums' },
            { key: 'billable', header: 'Billable', cell: (m) => formatDuration(m.stats?.billableS), className: 'hidden text-right tabular-nums md:table-cell' },
          ]}
        />
      </Card>
    </div>
  );
}

const VIEWS = [
  ['day', 'Day'],
  ['week', 'Week'],
  ['team', 'Team'],
];

/** Activity for one person (or the team in scope). */
export function PersonActivity({ employeeId, initialView = 'week', showTeam = false, date: controlledDate, onDate: controlledOnDate, view: controlledView, onView }) {
  const me = useMe();
  const [localDate, setLocalDate] = useState(() => todayIn(me.organization.timeZone));
  const [localView, setLocalView] = useState(initialView);
  const date = controlledDate ?? localDate;
  const onDate = controlledOnDate ?? setLocalDate;
  const view = controlledView ?? localView;
  const setView = onView ?? setLocalView;
  const views = VIEWS.filter(([id]) => id !== 'team' || showTeam);
  return (
    <div className="grid gap-4">
      <div role="tablist" aria-label="Activity view" className="flex gap-1 border-b">
        {views.map(([id, label]) => (
          <button key={id} role="tab" type="button" aria-selected={view === id} onClick={() => setView(id)} className={cn('h-10 border-b-2 px-3 text-sm', view === id ? 'border-primary font-medium text-primary' : 'border-transparent text-muted-foreground hover:text-foreground')}>
            {label}
          </button>
        ))}
      </div>
      {view === 'day' ? <DayView employeeId={employeeId} date={date} onDate={onDate} /> : view === 'team' ? <TeamView date={date} onDate={onDate} /> : <WeekView employeeId={employeeId} date={date} onDate={onDate} />}
    </div>
  );
}

export function ActivityPage() {
  const me = useMe();
  const router = useRouter();
  const params = useSearchParams();
  const scopes = me.permissions.find((p) => p.key === 'reports.attendance.read')?.scopes ?? [];
  const seesOthers = scopes.some((s) => s !== 'self');
  const people = useEmployees(seesOthers ? { status: 'ACTIVE', limit: 100, sort: 'name' } : undefined);
  const employeeId = params.get('employee') ?? '';
  const date = params.get('date') ?? todayIn(me.organization.timeZone);
  const view = params.get('view') ?? 'week';
  const update = (next) => {
    const q = new URLSearchParams({ view, date, ...(employeeId ? { employee: employeeId } : {}), ...next });
    if (!q.get('employee')) q.delete('employee');
    router.replace(`/activity?${q}`);
  };
  return (
    <>
      <PageHeader title="Activity" description="What was recorded: time at work, breaks, tracked time and events. Not a productivity score." />
      <p className="mb-4 flex items-start gap-2 text-sm text-muted-foreground">
        <Info aria-hidden className="mt-0.5 size-4 shrink-0" /> Measured: {KIND_HINT.measured} Derived: {KIND_HINT.derived}
      </p>
      {seesOthers && view !== 'team' ? (
        <label className="mb-4 flex max-w-sm flex-col gap-1.5 text-sm font-medium">
          Person
          <NativeSelect value={employeeId} onChange={(e) => update({ employee: e.target.value })}>
            <option value="">Me</option>
            {(people.data?.data ?? []).filter((p) => p.employeeId !== me.employeeId).map((p) => <option key={p.employeeId} value={p.employeeId}>{p.name}</option>)}
          </NativeSelect>
        </label>
      ) : null}
      <PersonActivity employeeId={employeeId || undefined} showTeam={seesOthers} date={date} onDate={(d) => update({ date: d })} view={view} onView={(v) => update({ view: v })} />
    </>
  );
}
