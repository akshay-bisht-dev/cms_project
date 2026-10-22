'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Laptop, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { passwordSchema, z } from '@orbit/validation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { FormField } from '@/components/common/form-field';
import { PageHeader } from '@/components/common/page-header';
import { ErrorState } from '@/components/common/states';
import { MfaEnrollment } from '@/features/auth/mfa-enrollment';
import { useMe } from '@/features/session/session-provider';
import { api } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { applyServerErrors } from '@/lib/forms';
import { queryKeys } from '@/lib/query-keys';

function describeDevice(userAgent = '') {
  const browser = /Edg\//.test(userAgent) ? 'Edge' : /Chrome\//.test(userAgent) ? 'Chrome' : /Firefox\//.test(userAgent) ? 'Firefox' : /Safari\//.test(userAgent) ? 'Safari' : 'Browser';
  const os = /Windows/.test(userAgent) ? 'Windows' : /Mac OS X/.test(userAgent) ? 'macOS' : /Android/.test(userAgent) ? 'Android' : /iPhone|iPad/.test(userAgent) ? 'iOS' : /Linux/.test(userAgent) ? 'Linux' : '';
  return [browser, os].filter(Boolean).join(' on ');
}

function Sessions() {
  const queryClient = useQueryClient();
  const sessions = useQuery({ queryKey: queryKeys.sessions, queryFn: async () => (await api.get('/auth/sessions')).data });
  const revoke = useMutation({
    mutationFn: (id) => api.delete(`/auth/sessions/${id}`),
    onSuccess: () => {
      toast.success('Session signed out');
      queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
    },
    onError: (error) => toast.error(error.message),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Where you are signed in</CardTitle>
        <CardDescription>Sign out of devices you do not recognize, then change your password.</CardDescription>
      </CardHeader>
      <CardContent>
        {sessions.isPending ? (
          <Skeleton className="h-24" />
        ) : sessions.error ? (
          <ErrorState error={sessions.error} onRetry={() => sessions.refetch()} />
        ) : (
          <ul className="divide-y">
            {sessions.data.map((s) => (
              <li key={s.id} className="flex items-center gap-3 py-3">
                <Laptop className="size-5 text-muted-foreground" aria-hidden />
                <div className="min-w-0 flex-1 text-sm">
                  <p className="font-medium">
                    {describeDevice(s.userAgent)}
                    {s.current && <span className="ml-2 rounded bg-success/10 px-1.5 py-0.5 text-xs text-success">This device</span>}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {s.ip ?? 'Unknown IP'} · active {formatRelative(s.lastSeenAt)}
                  </p>
                </div>
                {!s.current && (
                  <Button variant="outline" size="sm" onClick={() => revoke.mutate(s.id)} disabled={revoke.isPending}>
                    Sign out
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

const passwordForm = z
  .object({ currentPassword: z.string().min(1, 'Enter your current password'), newPassword: passwordSchema, confirm: z.string() })
  .refine((v) => v.newPassword === v.confirm, { path: ['confirm'], message: 'Passwords do not match' });

function ChangePassword() {
  const queryClient = useQueryClient();
  const form = useForm({ resolver: zodResolver(passwordForm), defaultValues: { currentPassword: '', newPassword: '', confirm: '' } });
  async function onSubmit({ currentPassword, newPassword }) {
    try {
      await api.post('/auth/change-password', { currentPassword, newPassword });
      toast.success('Password changed. Other devices were signed out.');
      form.reset();
      queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
    } catch (error) {
      if (!applyServerErrors(form, error)) toast.error(error.message);
    }
  }
  const e = form.formState.errors;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Password</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid max-w-sm gap-4">
          <FormField label="Current password" error={e.currentPassword?.message}>
            {(aria) => <Input type="password" autoComplete="current-password" {...aria} {...form.register('currentPassword')} />}
          </FormField>
          <FormField label="New password" hint="At least 12 characters." error={e.newPassword?.message}>
            {(aria) => <Input type="password" autoComplete="new-password" {...aria} {...form.register('newPassword')} />}
          </FormField>
          <FormField label="Confirm new password" error={e.confirm?.message}>
            {(aria) => <Input type="password" autoComplete="new-password" {...aria} {...form.register('confirm')} />}
          </FormField>
          <Button type="submit" className="justify-self-start" disabled={form.formState.isSubmitting}>
            Change password
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function TwoFactor() {
  const me = useMe();
  const queryClient = useQueryClient();
  const [disabling, setDisabling] = useState(false);
  const form = useForm({ defaultValues: { password: '', code: '' } });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['me'] });

  async function disable(values) {
    try {
      await api.post('/auth/mfa/disable', values);
      toast.success('Two-factor authentication turned off');
      setDisabling(false);
      refresh();
    } catch (error) {
      toast.error(error.details?.[0]?.message ?? error.message);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Two-factor authentication</CardTitle>
        <CardDescription>Requires a code from your phone when you sign in.</CardDescription>
      </CardHeader>
      <CardContent>
        {me.user.mfaEnabled ? (
          disabling ? (
            <form onSubmit={form.handleSubmit(disable)} className="grid max-w-sm gap-4">
              <FormField label="Password">{(aria) => <Input type="password" autoComplete="current-password" {...aria} {...form.register('password')} />}</FormField>
              <FormField label="Authenticator code">{(aria) => <Input inputMode="numeric" autoComplete="one-time-code" {...aria} {...form.register('code')} />}</FormField>
              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={() => setDisabling(false)}>
                  Cancel
                </Button>
                <Button type="submit" variant="destructive">
                  Turn off
                </Button>
              </div>
            </form>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <p className="flex items-center gap-2 text-sm text-success">
                <ShieldCheck className="size-4" aria-hidden /> On
              </p>
              <Button variant="outline" size="sm" onClick={() => setDisabling(true)}>
                Turn off
              </Button>
            </div>
          )
        ) : (
          <MfaEnrollment onComplete={refresh} />
        )}
      </CardContent>
    </Card>
  );
}

export function SecurityPage() {
  return (
    <>
      <PageHeader title="Security" description="Your password, two-factor authentication and signed-in devices." />
      <div className="grid gap-4 lg:grid-cols-2">
        <TwoFactor />
        <ChangePassword />
        <div className="lg:col-span-2">
          <Sessions />
        </div>
      </div>
    </>
  );
}
