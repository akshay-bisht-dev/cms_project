'use client';

import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, CircleAlert, RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const DEPENDENCIES = ['database', 'redis', 'storage'];

function statusFor(name, data, error) {
  if (data) return data.checks[name]?.status ?? 'unknown';
  // A 503 lists the failing dependencies in error.details; the rest responded.
  if (error?.code === 'UNAVAILABLE') return error.details.some((d) => d.path === name) ? 'down' : 'up';
  return 'unknown';
}

const TONE = { up: 'success', down: 'danger', unknown: 'neutral' };
const LABEL = { up: 'Operational', down: 'Unavailable', unknown: 'Unknown' };

export function SystemStatus() {
  const { data, error, isPending, isFetching, refetch } = useQuery({
    queryKey: ['health', 'ready'],
    queryFn: async () => (await api.get('/health/ready')).data,
    retry: false,
  });

  const unreachable = error && error.code !== 'UNAVAILABLE';

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>System status</CardTitle>
          <CardDescription>Readiness of the API and the services it depends on.</CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={isFetching ? 'animate-spin' : undefined} aria-hidden />
          Refresh
        </Button>
      </CardHeader>
      <CardContent>
        {isPending ? (
          <ul aria-label="Loading status" className="space-y-2">
            {DEPENDENCIES.map((name) => (
              <li key={name} className="h-11 animate-pulse rounded-md bg-muted" />
            ))}
          </ul>
        ) : unreachable ? (
          <div role="alert" className="flex items-start gap-2 rounded-md bg-danger/10 p-3 text-sm text-danger">
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            <div>
              <p className="font-medium">The API could not be reached.</p>
              <p>{error.message}{error.requestId ? ` (request ${error.requestId})` : ''}</p>
            </div>
          </div>
        ) : (
          <ul className="divide-y rounded-md border">
            {DEPENDENCIES.map((name) => {
              const status = statusFor(name, data, error);
              return (
                <li key={name} className="flex items-center justify-between px-4 py-3">
                  <span className="capitalize">{name}</span>
                  <Badge tone={TONE[status]}>
                    {status === 'up' ? <CheckCircle2 className="size-3.5" aria-hidden /> : <CircleAlert className="size-3.5" aria-hidden />}
                    {LABEL[status]}
                  </Badge>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
