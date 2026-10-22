'use client';

import { useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AlertTriangle, Camera, ChevronLeft, ChevronRight, Coffee, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input, NativeSelect } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/common/page-header';
import { EmptyState, ErrorState } from '@/components/common/states';
import { useEmployees } from '@/features/employees/queries';
import { useMe } from '@/features/session/session-provider';
import { addDays, formatTime, todayIn } from '@/lib/format';
import { FAILURE_LABEL, describeInterval } from './labels';
import { useThumbUrls, useTimeline } from './queries';
import { ScreenshotViewer } from './screenshot-viewer';

const HOUR = 3600_000;
const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;

/**
 * Splits the day into hours (by instant, so DST days have 23 or 25) and explains every working
 * hour without captures, so a gap is never mistaken for inactivity.
 */
export function buildHours(timeline, now = Date.now()) {
  const start = new Date(timeline.window.start).getTime();
  const end = new Date(timeline.window.end).getTime();
  const sessions = timeline.sessions.map((s) => ({
    start: new Date(s.startedAt).getTime(),
    end: s.endedAt ? new Date(s.endedAt).getTime() : now,
    breaks: s.breaks.map((b) => ({ start: new Date(b.startedAt).getTime(), end: b.endedAt ? new Date(b.endedAt).getTime() : now })),
  }));
  const breaks = sessions.flatMap((s) => s.breaks);
  const hasActiveAgent = timeline.agents.some((a) => a.status === 'ACTIVE');
  const hours = [];
  for (let h = start; h < end; h += HOUR) {
    const hEnd = h + HOUR;
    const shots = timeline.screenshots.filter((s) => {
      const t = new Date(s.capturedAt).getTime();
      return t >= h && t < hEnd;
    });
    const working = sessions.some((s) => overlaps(s.start, s.end, h, hEnd));
    if (!shots.length && (!working || h > now)) continue;
    const hourBreaks = breaks.filter((b) => overlaps(b.start, b.end, h, hEnd));
    let gap = null;
    if (!shots.length) {
      const workedMs = sessions.reduce((sum, s) => sum + Math.max(0, Math.min(s.end, hEnd) - Math.max(s.start, h)), 0);
      const breakMs = hourBreaks.reduce((sum, b) => sum + Math.max(0, Math.min(b.end, hEnd) - Math.max(b.start, h)), 0);
      if (workedMs - breakMs <= 0) gap = { icon: Coffee, text: 'On a break' };
      else if (!timeline.monitoring.enabled) gap = { icon: Camera, text: 'Screenshot monitoring is not enabled for this person' };
      else if (!hasActiveAgent) gap = { icon: AlertTriangle, text: 'No desktop app connected' };
      else gap = { icon: AlertTriangle, text: 'No captures: the desktop app was offline or paused' };
    }
    hours.push({ start: h, shots, breaks: hourBreaks, gap });
  }
  return hours;
}

function Tile({ shot, url, timeZone, onOpen }) {
  const time = formatTime(shot.capturedAt, timeZone);
  if (shot.status !== 'READY') {
    const processing = shot.status === 'UPLOADED' || shot.status === 'PENDING_UPLOAD';
    return (
      <div className="flex aspect-video flex-col items-center justify-center gap-1 rounded-md border border-dashed p-2 text-center text-xs text-muted-foreground">
        {processing ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <AlertTriangle aria-hidden className="size-4 text-warning" />}
        <span className="font-medium text-foreground">{time}</span>
        <span>{processing ? 'Processing' : (FAILURE_LABEL[shot.failureCode] ?? 'Not available')}</span>
      </div>
    );
  }
  return (
    <button type="button" onClick={() => onOpen(shot.id)} className="group grid gap-1 rounded-md text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
      <span className="block aspect-video overflow-hidden rounded-md border bg-muted">
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt="" className="size-full object-cover transition group-hover:opacity-90" />
        ) : (
          <Skeleton className="size-full" />
        )}
      </span>
      <span className="flex min-w-0 items-baseline justify-between gap-1 text-xs">
        <span className="font-medium">{time}</span>
        <span className="truncate text-muted-foreground">{shot.task?.key ?? shot.project?.code ?? ''}</span>
      </span>
      <span className="sr-only">Open screenshot from {time}</span>
    </button>
  );
}

/** One person's day of captures, grouped by hour with gaps explained. */
export function ScreenshotDay({ employeeId, date, onDateChange }) {
  const [open, setOpen] = useState(null);
  const timeline = useTimeline({ employeeId, date });
  const readyIds = useMemo(() => (timeline.data?.screenshots ?? []).filter((s) => s.status === 'READY').map((s) => s.id), [timeline.data]);
  const thumbs = useThumbUrls(readyIds);

  const tz = timeline.data?.timeZone;
  const hours = useMemo(() => (timeline.data ? buildHours(timeline.data) : []), [timeline.data]);
  const counts = useMemo(() => {
    const shots = timeline.data?.screenshots ?? [];
    return { ok: shots.filter((s) => s.status === 'READY' || s.status === 'UPLOADED').length, failed: shots.filter((s) => s.status === 'FAILED' || s.status === 'REJECTED').length };
  }, [timeline.data]);

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="icon" variant="outline" aria-label="Previous day" onClick={() => onDateChange(addDays(date, -1))}>
          <ChevronLeft aria-hidden />
        </Button>
        <Input type="date" aria-label="Day" value={date} onChange={(e) => e.target.value && onDateChange(e.target.value)} className="w-auto" />
        <Button size="icon" variant="outline" aria-label="Next day" onClick={() => onDateChange(addDays(date, 1))}>
          <ChevronRight aria-hidden />
        </Button>
        {timeline.data ? (
          <p className="text-sm text-muted-foreground">
            {counts.ok} captured · {counts.failed} missing · {timeline.data.monitoring.enabled ? describeInterval(timeline.data.monitoring.intervalS) : 'monitoring off'} · times in {tz}
          </p>
        ) : null}
      </div>

      {timeline.isPending ? (
        <Skeleton className="h-64" role="status" aria-label="Loading screenshots" />
      ) : timeline.error ? (
        <ErrorState error={timeline.error} onRetry={() => timeline.refetch()} />
      ) : hours.length === 0 ? (
        <EmptyState icon={Camera} title="Nothing on this day" description="No work sessions or captures were recorded." />
      ) : (
        <ol className="grid gap-4" aria-label={`Screenshots on ${date}`}>
          {hours.map((hour) => (
            <li key={hour.start} className="grid gap-2 sm:grid-cols-[4.5rem_1fr]">
              <div className="text-sm font-medium tabular-nums">{formatTime(hour.start, tz)}</div>
              <div className="grid gap-2">
                {hour.breaks.length ? (
                  <p className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                    {hour.breaks.map((b) => (
                      <span key={b.start} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5">
                        <Coffee aria-hidden className="size-3" /> Break {formatTime(b.start, tz)}–{formatTime(b.end, tz)}
                      </span>
                    ))}
                  </p>
                ) : null}
                {hour.gap ? (
                  <p className="flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
                    <hour.gap.icon aria-hidden className="size-4" /> {hour.gap.text}
                  </p>
                ) : (
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                    {hour.shots.map((shot) => (
                      <Tile key={shot.id} shot={shot} url={thumbs.data?.get(shot.id)} timeZone={tz} onOpen={setOpen} />
                    ))}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
      {open ? <ScreenshotViewer screenshotId={open} timeZone={tz} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

/** /screenshots: pick a person (when allowed) and a day. */
export function ScreenshotsPage() {
  const me = useMe();
  const router = useRouter();
  const params = useSearchParams();
  const zone = me.organization.timeZone;
  const scopes = me.permissions.find((p) => p.key === 'monitoring.screenshots.read')?.scopes ?? [];
  const seesOthers = scopes.some((s) => s !== 'self');
  const people = useEmployees(seesOthers ? { status: 'ACTIVE', limit: 100, sort: 'name' } : undefined);
  const employeeId = params.get('employee') ?? '';
  const date = params.get('date') ?? todayIn(zone);

  function update(next) {
    const query = new URLSearchParams({ ...(employeeId ? { employee: employeeId } : {}), date, ...next });
    if (!query.get('employee')) query.delete('employee');
    router.replace(`/screenshots?${query}`);
  }

  return (
    <>
      <PageHeader title="Screenshots" description="Captured by the desktop app while people are clocked in and working. Every view is logged." />
      <Card>
        <CardContent className="grid gap-4 pt-6">
          {seesOthers ? (
            <label className="flex max-w-sm flex-col gap-1.5 text-sm font-medium">
              Person
              <NativeSelect value={employeeId} onChange={(e) => update({ employee: e.target.value })}>
                <option value="">Me</option>
                {(people.data?.data ?? [])
                  .filter((p) => p.employeeId !== me.employeeId)
                  .map((p) => (
                    <option key={p.employeeId} value={p.employeeId}>
                      {p.name}
                    </option>
                  ))}
              </NativeSelect>
            </label>
          ) : null}
          <ScreenshotDay employeeId={employeeId || undefined} date={date} onDateChange={(d) => update({ date: d })} />
        </CardContent>
      </Card>
    </>
  );
}

/** Profile → Screenshots tab. */
export function EmployeeScreenshots({ employeeId }) {
  const me = useMe();
  const [date, setDate] = useState(() => todayIn(me.organization.timeZone));
  return (
    <Card>
      <CardContent className="pt-6">
        <ScreenshotDay employeeId={employeeId} date={date} onDateChange={setDate} />
      </CardContent>
    </Card>
  );
}
