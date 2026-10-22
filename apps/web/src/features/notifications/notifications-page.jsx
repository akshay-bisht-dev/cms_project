'use client';

import { useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellOff } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { PageHeader } from '@/components/common/page-header';
import { EmptyState, ErrorState } from '@/components/common/states';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { NotificationItem, useNotificationActions } from './notification-bell';

function Preferences() {
  const queryClient = useQueryClient();
  const prefs = useQuery({ queryKey: queryKeys.notificationPreferences, queryFn: async () => (await api.get('/notifications/preferences')).data });
  const save = useMutation({
    mutationFn: (preferences) => api.put('/notifications/preferences', { preferences }),
    onSuccess: ({ data }) => queryClient.setQueryData(queryKeys.notificationPreferences, data),
    onError: (error) => toast.error(error.message),
  });
  const update = (type, channel, value) =>
    save.mutate(prefs.data.map((p) => (p.type === type ? { type: p.type, inApp: p.inApp, email: p.email, [channel]: value } : { type: p.type, inApp: p.inApp, email: p.email })));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Preferences</CardTitle>
        <CardDescription>Choose where each kind of notification reaches you.</CardDescription>
      </CardHeader>
      <CardContent>
        {prefs.isPending ? (
          <Skeleton className="h-24" />
        ) : prefs.error ? (
          <ErrorState error={prefs.error} onRetry={() => prefs.refetch()} />
        ) : (
          <table className="w-full text-sm">
            <caption className="sr-only">Notification preferences</caption>
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th scope="col" className="pb-2 font-medium">Notification</th>
                <th scope="col" className="pb-2 text-center font-medium">In app</th>
                <th scope="col" className="pb-2 text-center font-medium">Email</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {prefs.data.map((p) => (
                <tr key={p.type}>
                  <td className="py-3 pr-4">{p.label}</td>
                  <td className="py-3 text-center">
                    <Switch checked={p.inApp} onCheckedChange={(v) => update(p.type, 'inApp', v)} aria-label={`${p.label}: in app`} />
                  </td>
                  <td className="py-3 text-center">
                    <Switch checked={p.email} onCheckedChange={(v) => update(p.type, 'email', v)} aria-label={`${p.label}: email`} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}

export function NotificationsPage() {
  const [unreadOnly, setUnreadOnly] = useState(false);
  const { markRead, markAllRead } = useNotificationActions();
  const list = useInfiniteQuery({
    queryKey: queryKeys.notifications({ page: 'all', unreadOnly }),
    queryFn: ({ pageParam }) => api.get('/notifications', { query: { cursor: pageParam, limit: 20, unreadOnly } }),
    initialPageParam: undefined,
    getNextPageParam: (last) => last.meta.page.nextCursor ?? undefined,
  });
  const items = list.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <>
      <PageHeader
        title="Notifications"
        actions={
          <Button variant="outline" onClick={() => markAllRead.mutate()} disabled={markAllRead.isPending}>
            Mark all read
          </Button>
        }
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>{unreadOnly ? 'Unread' : 'All notifications'}</CardTitle>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={unreadOnly} onCheckedChange={setUnreadOnly} aria-label="Show unread only" />
              Unread only
            </label>
          </CardHeader>
          <CardContent>
            {list.isPending ? (
              <div className="space-y-2">
                <Skeleton className="h-12" />
                <Skeleton className="h-12" />
              </div>
            ) : list.error ? (
              <ErrorState error={list.error} onRetry={() => list.refetch()} />
            ) : items.length === 0 ? (
              <EmptyState icon={BellOff} title={unreadOnly ? 'No unread notifications' : 'No notifications yet'} />
            ) : (
              <div className="grid gap-1">
                {items.map((n) => (
                  <NotificationItem key={n.id} notification={n} onOpen={(item) => !item.readAt && markRead.mutate(item.id)} />
                ))}
              </div>
            )}
            {list.hasNextPage && (
              <Button variant="outline" size="sm" className="mt-4" onClick={() => list.fetchNextPage()} disabled={list.isFetchingNextPage}>
                Load more
              </Button>
            )}
          </CardContent>
        </Card>
        <Preferences />
      </div>
    </>
  );
}
