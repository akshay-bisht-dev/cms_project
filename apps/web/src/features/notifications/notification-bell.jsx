'use client';

import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { queryKeys } from '@/lib/query-keys';
import { cn } from '@/lib/utils';

export function useNotificationActions() {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['notifications'] });
  return {
    markRead: useMutation({ mutationFn: (id) => api.post(`/notifications/${id}/read`), onSuccess: refresh }),
    markAllRead: useMutation({ mutationFn: () => api.post('/notifications/read-all'), onSuccess: refresh }),
  };
}

export function NotificationItem({ notification, onOpen }) {
  const unread = !notification.readAt;
  const body = (
    <div className="flex gap-3">
      <span aria-hidden className={cn('mt-1.5 size-2 shrink-0 rounded-full', unread ? 'bg-primary' : 'bg-transparent')} />
      <div className="min-w-0">
        <p className={cn('text-sm', unread && 'font-medium')}>
          {notification.title}
          {unread && <span className="sr-only"> (unread)</span>}
        </p>
        {notification.body && <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{notification.body}</p>}
        <p className="mt-1 text-xs text-muted-foreground">{formatRelative(notification.createdAt)}</p>
      </div>
    </div>
  );
  return notification.link ? (
    <Link href={notification.link} onClick={() => onOpen?.(notification)} className="block rounded-md p-2 hover:bg-muted">
      {body}
    </Link>
  ) : (
    <button type="button" onClick={() => onOpen?.(notification)} className="block w-full rounded-md p-2 text-left hover:bg-muted">
      {body}
    </button>
  );
}

export function NotificationBell() {
  const { markRead, markAllRead } = useNotificationActions();
  const { data: count = 0 } = useQuery({
    queryKey: queryKeys.unreadCount,
    queryFn: async () => (await api.get('/notifications/unread-count')).data.count,
    refetchInterval: 120_000,
  });
  const recent = useQuery({
    queryKey: queryKeys.notifications({ limit: 8 }),
    queryFn: async () => (await api.get('/notifications', { query: { limit: 8 } })).data,
  });

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label={count ? `Notifications, ${count} unread` : 'Notifications'}>
          <Bell aria-hidden />
          {count > 0 && (
            <span aria-hidden className="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-danger px-1 text-[10px] leading-4 font-semibold text-white">
              {count > 99 ? '99+' : count}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="p-0">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-sm font-semibold">Notifications</h2>
          <Button variant="ghost" size="sm" disabled={!count || markAllRead.isPending} onClick={() => markAllRead.mutate()}>
            Mark all read
          </Button>
        </div>
        <div className="max-h-96 overflow-y-auto p-2">
          {recent.isPending ? (
            <div className="space-y-2 p-2">
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
            </div>
          ) : recent.data?.length ? (
            recent.data.map((n) => <NotificationItem key={n.id} notification={n} onOpen={(item) => !item.readAt && markRead.mutate(item.id)} />)
          ) : (
            <p className="px-2 py-8 text-center text-sm text-muted-foreground">You are all caught up.</p>
          )}
        </div>
        <div className="border-t p-2">
          <Button asChild variant="ghost" size="sm" className="w-full">
            <Link href="/notifications">View all</Link>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
