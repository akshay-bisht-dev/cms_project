'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';

/**
 * The member's work state from the server. The displayed timer is derived from server start
 * times plus the measured offset between the server and this browser's clock, so a wrong local
 * clock or a page refresh never changes the tracked time.
 */
export function useWorkState() {
  const query = useQuery({
    queryKey: queryKeys.workState,
    queryFn: async () => {
      const sentAt = Date.now();
      const { data } = await api.get('/attendance/state');
      const receivedAt = Date.now();
      return { ...data, clockOffsetMs: Date.parse(data.serverTime) - (sentAt + receivedAt) / 2 };
    },
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  return query;
}

/** Re-renders every second while `active`, returning the server-aligned current time. */
export function useServerNow(offsetMs = 0, active = true) {
  const [now, setNow] = useState(() => Date.now() + offsetMs);
  useEffect(() => {
    if (!active) return undefined;
    const tick = () => setNow(Date.now() + offsetMs);
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [offsetMs, active]);
  return now;
}

const ACTIONS = {
  clockIn: { path: '/attendance/clock-in', idempotent: true, success: 'Clocked in' },
  clockOut: { path: '/attendance/clock-out', idempotent: true, success: 'Clocked out' },
  startBreak: { path: '/attendance/break/start', success: 'Break started' },
  endBreak: { path: '/attendance/break/end', success: 'Welcome back' },
  startTimer: { path: '/time-tracking/start', idempotent: true, success: 'Timer started' },
  pauseTimer: { path: '/time-tracking/pause', success: 'Timer paused' },
  resumeTimer: { path: '/time-tracking/resume', success: 'Timer resumed' },
  stopTimer: { path: '/time-tracking/stop', idempotent: true, success: 'Timer stopped' },
  switchTimer: { path: '/time-tracking/switch', success: 'Switched task' },
};

/** Transition mutations. Each returns the fresh state, which replaces the cache immediately. */
export function useWorkActions() {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: async ({ action, body }) => {
      const { path, idempotent } = ACTIONS[action];
      const sentAt = Date.now();
      const { data } = await api.post(path, body, idempotent ? { idempotencyKey: crypto.randomUUID() } : {});
      return { ...data, clockOffsetMs: Date.parse(data.serverTime) - (sentAt + Date.now()) / 2 };
    },
    onSuccess: (data, { action }) => {
      queryClient.setQueryData(queryKeys.workState, data);
      queryClient.invalidateQueries({ queryKey: ['time-entries'] });
      queryClient.invalidateQueries({ queryKey: ['attendance'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      toast.success(ACTIONS[action].success);
    },
    onError: (error) => {
      toast.error(error.message);
      queryClient.invalidateQueries({ queryKey: queryKeys.workState });
    },
  });
  return useMemo(
    () => ({ run: (action, body) => mutation.mutate({ action, body }), pending: mutation.isPending }),
    [mutation],
  );
}
