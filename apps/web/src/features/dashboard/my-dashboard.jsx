'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Bell, ShieldAlert, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/common/states';
import { NotificationItem, useNotificationActions } from '@/features/notifications/notification-bell';
import { useEmployee } from '@/features/employees/queries';
import { useMe } from '@/features/session/session-provider';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';

function greeting(timeZone) {
  const hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone }).format(new Date()));
  return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
}

export function MyDashboard() {
  const me = useMe();
  const profile = useEmployee(me.employeeId);
  const notifications = useQuery({
    queryKey: queryKeys.notifications({ limit: 5, unreadOnly: true }),
    queryFn: async () => (await api.get('/notifications', { query: { limit: 5, unreadOnly: true } })).data,
  });
  const { markRead } = useNotificationActions();
  const p = profile.data;

  return (
    <>
      <div className="mb-6">
        <h1 className="text-xl font-semibold">
          {greeting(me.organization.timeZone)}, {me.user.name.split(' ')[0]}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{me.organization.name}</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-start justify-between">
            <div>
              <CardTitle>Unread notifications</CardTitle>
              <CardDescription>Changes to your profile, roles and invitations.</CardDescription>
            </div>
            <Button variant="ghost" size="sm" asChild>
              <Link href="/notifications">
                All <ArrowRight aria-hidden />
              </Link>
            </Button>
          </CardHeader>
          <CardContent>
            {notifications.isPending ? (
              <Skeleton className="h-24" />
            ) : notifications.data?.length ? (
              <div className="grid gap-1">
                {notifications.data.map((n) => (
                  <NotificationItem key={n.id} notification={n} onOpen={(item) => markRead.mutate(item.id)} />
                ))}
              </div>
            ) : (
              <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                <Bell className="size-4" aria-hidden /> You are all caught up.
              </p>
            )}
          </CardContent>
        </Card>

        <div className="grid content-start gap-4">
          <Card>
            <CardHeader>
              <CardTitle>My profile</CardTitle>
            </CardHeader>
            <CardContent>
              {profile.isPending ? (
                <Skeleton className="h-20" />
              ) : profile.error ? (
                <ErrorState error={profile.error} onRetry={() => profile.refetch()} />
              ) : (
                <>
                  <p className="text-sm">
                    {p.designation ?? 'No designation'}
                    {p.department && ` · ${p.department.name}`}
                  </p>
                  {p.manager && <p className="mt-1 text-sm text-muted-foreground">Reports to {p.manager.name}</p>}
                  <p className="mt-3 text-sm">
                    Profile <span className="font-semibold">{p.profileCompletion}%</span> complete
                  </p>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label="Profile completion" aria-valuenow={p.profileCompletion} aria-valuemin={0} aria-valuemax={100}>
                    <div className="h-full bg-primary" style={{ width: `${p.profileCompletion}%` }} />
                  </div>
                  <Button variant="outline" size="sm" className="mt-4" asChild>
                    <Link href={`/employees/${me.employeeId}/profile`}>Update profile</Link>
                  </Button>
                </>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Account security</CardTitle>
            </CardHeader>
            <CardContent>
              {me.user.mfaEnabled ? (
                <p className="flex items-center gap-2 text-sm text-success">
                  <ShieldCheck className="size-4" aria-hidden /> Two-factor authentication is on
                </p>
              ) : (
                <>
                  <p className="flex items-center gap-2 text-sm text-warning">
                    <ShieldAlert className="size-4" aria-hidden /> Two-factor authentication is off
                  </p>
                  <Button size="sm" className="mt-3" asChild>
                    <Link href="/account/security">Turn it on</Link>
                  </Button>
                </>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
