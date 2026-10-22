'use client';

import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { NativeSelect } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/common/page-header';
import { ErrorState } from '@/components/common/states';
import { useTeams } from '@/features/employees/queries';
import { formatDuration } from '@/lib/format';
import { formatPercent } from './metrics';
import { useTrends } from './queries';

const axis = { tickLine: false, axisLine: false, tick: { fill: 'var(--muted-foreground)', fontSize: 12 } };
const weekLabel = (iso) => new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));

function TipBox({ active, payload, format }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  return (
    <div className="rounded-md border bg-card px-3 py-2 text-xs shadow-md">
      <p className="font-medium">Week of {weekLabel(row.weekStart)}{row.partial ? ' (so far)' : ''}</p>
      {payload.map((p) => (
        <p key={p.dataKey}>{p.name}: {format(row[p.dataKey.replace(/H$/, 'S')] ?? row[p.dataKey])}</p>
      ))}
    </div>
  );
}

/** One metric per chart (small multiples), one axis each, with a table for screen readers. */
function TrendCard({ title, formula, kind, series, data, format, children }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>
          <span className="font-medium">{kind === 'derived' ? 'Derived' : 'Measured'}</span> · {formula}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <figure>
          <div className="h-52" aria-hidden>
            <ResponsiveContainer width="100%" height="100%">{children}</ResponsiveContainer>
          </div>
          <table className="sr-only">
            <caption>{title} by week</caption>
            <thead><tr><th scope="col">Week</th>{series.map((s) => <th key={s.key} scope="col">{s.name}</th>)}</tr></thead>
            <tbody>{data.map((r) => <tr key={r.weekStart}><td>{r.weekStart}</td>{series.map((s) => <td key={s.key}>{format(r[s.key])}</td>)}</tr>)}</tbody>
          </table>
        </figure>
      </CardContent>
    </Card>
  );
}

function PercentLine({ title, formula, dataKey, data, emptyReason }) {
  const series = [{ key: dataKey, name: title }];
  if (data.every((r) => r[dataKey] === null || r[dataKey] === undefined)) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription><span className="font-medium">Derived</span> · {formula}</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No value for this period: {emptyReason}</p>
        </CardContent>
      </Card>
    );
  }
  return (
    <TrendCard title={title} formula={formula} kind="derived" series={series} data={data} format={formatPercent}>
      <LineChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: -8 }} accessibilityLayer={false}>
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis dataKey="weekStart" tickFormatter={weekLabel} {...axis} />
        <YAxis domain={[0, 1]} tickFormatter={(v) => `${Math.round(v * 100)}%`} {...axis} />
        <Tooltip content={<TipBox format={formatPercent} />} />
        <Line name={title} dataKey={dataKey} stroke="var(--series-1)" strokeWidth={2} dot={{ r: 4, fill: 'var(--series-1)', strokeWidth: 2, stroke: 'var(--card)' }} connectNulls={false} isAnimationActive={false} />
      </LineChart>
    </TrendCard>
  );
}

export function InsightsPage() {
  const [weeks, setWeeks] = useState(8);
  const [teamId, setTeamId] = useState('');
  const teams = useTeams();
  const trends = useTrends({ weeks, teamId: teamId || undefined });
  const data = (trends.data?.series ?? []).map((r) => ({ ...r, trackedH: r.trackedS / 3600, billableH: r.billableS / 3600 }));

  return (
    <>
      <PageHeader title="Insights" description="Weekly trends for the people you can report on. Every figure is measured or derived from records; none is a productivity score." />
      <div className="mb-6 flex flex-wrap gap-4">
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Period
          <NativeSelect value={weeks} onChange={(e) => setWeeks(Number(e.target.value))}>
            {[4, 8, 12, 26].map((w) => <option key={w} value={w}>Last {w} weeks</option>)}
          </NativeSelect>
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Team
          <NativeSelect value={teamId} onChange={(e) => setTeamId(e.target.value)}>
            <option value="">Everyone in my scope</option>
            {(teams.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </NativeSelect>
        </label>
      </div>
      {trends.isPending ? (
        <Skeleton className="h-96" role="status" aria-label="Loading insights" />
      ) : trends.error ? (
        <ErrorState error={trends.error} onRetry={() => trends.refetch()} />
      ) : (
        <div className="grid gap-6">
          <p className="text-sm text-muted-foreground">
            {trends.data.people} {trends.data.people === 1 ? 'person' : 'people'}. The latest week is partial.
            {trends.data.complete ? '' : ' Some days are still being calculated in the background; refresh shortly for complete figures.'}
          </p>
          <TrendCard
            title="Tracked and billable hours"
            formula="Σ time entries per week, split by billable"
            kind="measured"
            series={[{ key: 'trackedS', name: 'Tracked' }, { key: 'billableS', name: 'Billable' }]}
            data={data}
            format={formatDuration}
          >
            <BarChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: -8 }} barGap={2} accessibilityLayer={false}>
              <CartesianGrid vertical={false} stroke="var(--border)" />
              <XAxis dataKey="weekStart" tickFormatter={weekLabel} {...axis} />
              <YAxis allowDecimals={false} {...axis} />
              <Tooltip content={<TipBox format={formatDuration} />} cursor={{ fill: 'var(--muted)' }} />
              <Legend verticalAlign="top" align="right" iconType="square" wrapperStyle={{ fontSize: 12 }} />
              <Bar name="Tracked" dataKey="trackedH" fill="var(--series-1)" radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={false} />
              <Bar name="Billable" dataKey="billableH" fill="var(--series-2)" radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={false} />
            </BarChart>
          </TrendCard>
          <div className="grid gap-6 lg:grid-cols-2">
            <PercentLine title="Attendance rate" formula="days present ÷ scheduled working days" dataKey="attendanceRate" data={data} emptyReason="nobody had scheduled working days (set up a work schedule under Settings → Attendance)." />
            <PercentLine title="Billable utilization" formula="billable time ÷ scheduled time" dataKey="utilization" data={data} emptyReason="there was no scheduled time to divide by." />
            {trends.data.monitoredPeople ? (
              <PercentLine title="Screenshot coverage" formula="captures received ÷ expected while monitored (pipeline health only)" dataKey="coverage" data={data} emptyReason="no captures were expected (nobody was monitored while working)." />
            ) : null}
          </div>
        </div>
      )}
    </>
  );
}
