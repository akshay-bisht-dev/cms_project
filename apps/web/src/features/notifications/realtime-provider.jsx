'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { io } from 'socket.io-client';
import { toast } from 'sonner';

/**
 * Opens one Socket.IO connection per signed-in tab. Events are hints: they invalidate queries so
 * data is refetched through the REST API (which enforces permissions), never applied directly.
 */
export function RealtimeProvider({ organizationId, children }) {
  const queryClient = useQueryClient();
  const router = useRouter();

  useEffect(() => {
    const url = process.env.NEXT_PUBLIC_REALTIME_URL || undefined;
    const socket = io(url, { path: '/socket.io', transports: ['websocket'], withCredentials: true });
    socket.on('notification.created', () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
      toast('You have a new notification');
    });
    // Presence hints: my own state changed (another tab or device), or someone in my scope did.
    socket.on('presence.changed', () => {
      queryClient.invalidateQueries({ queryKey: ['work-state'] });
      queryClient.invalidateQueries({ queryKey: ['attendance', 'board'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    });
    socket.on('session.ended', () => {
      queryClient.clear();
      router.replace('/login?reason=session-ended');
    });
    return () => socket.disconnect();
  }, [organizationId, queryClient, router]);

  return children;
}
