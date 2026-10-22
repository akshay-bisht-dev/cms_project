'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Coffee, LogIn, LogOut, Pause, Play, Square, Timer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useCan } from '@/features/session/session-provider';
import { formatDuration, formatTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useServerNow, useWorkActions, useWorkState } from './use-work-state';
import { WorkPicker } from '@/features/projects/work-picker';

const elapsed = (start, now) => Math.max(0, (now - Date.parse(start)) / 1000);

export function TimeControl() {
  const canClock = useCan('attendance.self');
  const canTime = useCan('time.self');
  const { data: ws } = useWorkState();
  const { run, pending } = useWorkActions();
  const [description, setDescription] = useState('');
  const [billable, setBillable] = useState(false);
  const [work, setWork] = useState({ projectId: null, taskId: null });
  const running = ws?.timer.state === 'RUNNING';
  const now = useServerNow(ws?.clockOffsetMs ?? 0, Boolean(ws && ws.state !== 'OFF'));

  if (!canClock || !ws) return null;

  // Server totals as of the snapshot, plus time elapsed since it (server-aligned), while counting.
  const sinceSnapshotS = Math.max(0, (now - Date.parse(ws.serverTime)) / 1000);
  const workedS = ws.today.workedS + (ws.state === 'WORKING' ? sinceSnapshotS : 0);
  const trackedS = ws.today.trackedS + (running ? sinceSnapshotS : 0);

  const status =
    ws.state === 'ON_BREAK'
      ? { label: `On break ${formatDuration(elapsed(ws.break.startedAt, now))}`, tone: 'bg-warning/10 text-warning', Icon: Coffee }
      : running
        ? { label: formatDuration(elapsed(ws.timer.entry.startedAt, now), { showSeconds: true }), tone: 'bg-primary/10 text-primary', Icon: Timer }
        : ws.state === 'WORKING'
          ? { label: 'Working', tone: 'bg-success/10 text-success', Icon: Timer }
          : null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        {status ? (
          <button type="button" className={cn('inline-flex h-8 items-center gap-2 rounded-full px-3 text-sm font-medium tabular-nums', status.tone)}>
            <status.Icon className="size-4" aria-hidden />
            <span aria-hidden>{status.label}</span>
            <span className="sr-only">Time tracking: {ws.state === 'ON_BREAK' ? 'on break' : running ? 'timer running' : 'clocked in'}</span>
          </button>
        ) : (
          <Button size="sm" variant="outline">
            <LogIn aria-hidden /> Clock in
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent className="w-80 p-4">
        <p role="status" className="sr-only">
          {ws.state === 'OFF' ? 'Clocked out' : ws.state === 'ON_BREAK' ? 'On break' : running ? 'Timer running' : 'Clocked in'}
        </p>
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold">Today</h2>
          <span className="text-xs text-muted-foreground">{ws.timeZone}</span>
        </div>
        <dl className="mb-4 grid grid-cols-2 gap-3 text-sm">
          <div className="rounded-md bg-muted p-2">
            <dt className="text-xs text-muted-foreground">Worked</dt>
            <dd className="font-semibold tabular-nums">{formatDuration(workedS)}</dd>
          </div>
          <div className="rounded-md bg-muted p-2">
            <dt className="text-xs text-muted-foreground">Tracked</dt>
            <dd className="font-semibold tabular-nums">{formatDuration(trackedS)}</dd>
          </div>
        </dl>

        {ws.state === 'OFF' ? (
          <Button className="w-full" disabled={pending} onClick={() => run('clockIn', {})}>
            <LogIn aria-hidden /> Clock in
          </Button>
        ) : (
          <div className="grid gap-2">
            <p className="text-xs text-muted-foreground">Clocked in at {formatTime(ws.session?.startedAt, ws.timeZone)}</p>
            <div className="grid grid-cols-2 gap-2">
              {ws.state === 'ON_BREAK' ? (
                <Button variant="outline" disabled={pending} onClick={() => run('endBreak')}>
                  <Play aria-hidden /> End break
                </Button>
              ) : (
                <Button variant="outline" disabled={pending} onClick={() => run('startBreak')}>
                  <Coffee aria-hidden /> Break
                </Button>
              )}
              <Button variant="outline" disabled={pending} onClick={() => run('clockOut')}>
                <LogOut aria-hidden /> Clock out
              </Button>
            </div>
          </div>
        )}

        {canTime && ws.state !== 'ON_BREAK' && (
          <div className="mt-4 border-t pt-4">
            <h3 className="mb-2 text-sm font-semibold">Timer</h3>
            {running ? (
              <>
                <p className="mb-3 truncate text-sm">{ws.timer.entry.description || 'No description'}</p>
                <div className="grid grid-cols-2 gap-2">
                  <Button variant="outline" disabled={pending} onClick={() => run('pauseTimer')}>
                    <Pause aria-hidden /> Pause
                  </Button>
                  <Button variant="destructive" disabled={pending} onClick={() => run('stopTimer')}>
                    <Square aria-hidden /> Stop
                  </Button>
                </div>
              </>
            ) : ws.timer.state === 'PAUSED' ? (
              <>
                <p className="mb-3 truncate text-sm text-muted-foreground">Paused: {ws.timer.context?.description || 'No description'}</p>
                <div className="grid grid-cols-2 gap-2">
                  <Button disabled={pending} onClick={() => run('resumeTimer')}>
                    <Play aria-hidden /> Resume
                  </Button>
                  <Button variant="outline" disabled={pending} onClick={() => run('stopTimer')}>
                    <Square aria-hidden /> Stop
                  </Button>
                </div>
              </>
            ) : (
              <form
                className="grid gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  run('startTimer', { description: description || undefined, isBillable: billable, ...(work.projectId ? { projectId: work.projectId } : {}), ...(work.taskId ? { taskId: work.taskId } : {}) });
                  setDescription('');
                }}
              >
                <WorkPicker projectId={work.projectId} taskId={work.taskId} onChange={setWork} idPrefix="timer" />
                <Input aria-label="What are you working on?" placeholder="What are you working on?" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={billable} onChange={(e) => setBillable(e.target.checked)} />
                  Billable
                </label>
                <Button type="submit" disabled={pending}>
                  <Play aria-hidden /> Start timer
                </Button>
              </form>
            )}
          </div>
        )}
        <Link href="/time" className="mt-4 block text-center text-sm text-primary hover:underline">
          View my time
        </Link>
      </PopoverContent>
    </Popover>
  );
}
