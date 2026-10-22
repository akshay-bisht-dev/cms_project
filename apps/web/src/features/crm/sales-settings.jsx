'use client';

import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, NativeSelect } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/common/page-header';
import { ErrorState } from '@/components/common/states';
import { useCan } from '@/features/session/session-provider';
import { api } from '@/lib/api';
import { PRIORITY } from './labels';
import { useAction, useStages } from './queries';

const PRIORITIES = ['URGENT', 'HIGH', 'NORMAL', 'LOW'];
const hours = (min) => String(Math.round((min / 60) * 100) / 100);

function Stages() {
  const stages = useStages();
  const save = useAction(({ id, ...body }) => api.patch(`/pipeline-stages/${id}`, body), { success: 'Stage saved' });
  if (stages.isPending) return <Skeleton className="h-32" />;
  if (stages.error) return <ErrorState error={stages.error} />;
  return (
    <Card>
      <CardHeader><CardTitle>Pipeline stages</CardTitle><CardDescription>Moving an opportunity into a stage sets its probability to the stage’s default.</CardDescription></CardHeader>
      <CardContent>
        <ul className="grid gap-3">
          {stages.data.map((s) => (
            <li key={s.id}>
              <form
                className="grid grid-cols-[1fr_7rem_auto] items-end gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  save.mutate({ id: s.id, name: f.get('name'), defaultProbability: Number(f.get('probability')) });
                }}
              >
                <label className="grid gap-1 text-sm">Name<Input name="name" defaultValue={s.name} required maxLength={80} /></label>
                <label className="grid gap-1 text-sm">Probability %<Input name="probability" type="number" min={0} max={100} defaultValue={s.defaultProbability} /></label>
                <Button type="submit" variant="outline" aria-label={`Save ${s.name}`}>Save</Button>
              </form>
              {s.isWon || s.isLost ? <p className="mt-1 text-xs text-muted-foreground">{s.isWon ? 'Closes the deal as won.' : 'Closes the deal as lost (a reason is required).'}</p> : null}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function SlaPolicies() {
  const policies = useQuery({ queryKey: ['tickets', 'sla'], queryFn: async () => (await api.get('/sla-policies')).data });
  const schedules = useQuery({ queryKey: ['attendance', 'schedules'], queryFn: async () => (await api.get('/attendance/schedules')).data });
  const save = useAction(({ id, ...body }) => api.patch(`/sla-policies/${id}`, body), { success: 'SLA policy saved', keys: [['tickets']] });
  if (policies.isPending) return <Skeleton className="h-32" />;
  if (policies.error) return <ErrorState error={policies.error} />;
  return (
    <Card>
      <CardHeader><CardTitle>SLA targets</CardTitle><CardDescription>Hours to first response and to resolution. With business hours set, only time inside the schedule counts and holidays are skipped. Changes apply to new tickets.</CardDescription></CardHeader>
      <CardContent className="grid gap-6">
        {policies.data.map((p) => (
          <form
            key={p.id}
            className="grid gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              const targets = Object.fromEntries(PRIORITIES.map((pr) => [pr, { firstResponseMin: Math.round(Number(f.get(`${pr}-first`)) * 60), resolutionMin: Math.round(Number(f.get(`${pr}-res`)) * 60) }]));
              save.mutate({ id: p.id, targets, scheduleId: f.get('scheduleId') || null });
            }}
          >
            <p className="font-medium">{p.name}{p.isDefault ? ' (default)' : ''}</p>
            <div className="grid gap-2 sm:grid-cols-4">
              {PRIORITIES.map((pr) => (
                <fieldset key={pr} className="grid gap-1 rounded-md border p-3 text-sm">
                  <legend className="px-1 font-medium">{PRIORITY[pr][0]}</legend>
                  <label className="grid gap-1">First response (h)<Input name={`${pr}-first`} type="number" min={0.25} step="0.25" defaultValue={hours(p.targets[pr].firstResponseMin)} /></label>
                  <label className="grid gap-1">Resolution (h)<Input name={`${pr}-res`} type="number" min={0.25} step="0.25" defaultValue={hours(p.targets[pr].resolutionMin)} /></label>
                </fieldset>
              ))}
            </div>
            <label className="grid max-w-sm gap-1 text-sm">Business hours
              <NativeSelect name="scheduleId" defaultValue={p.scheduleId ?? ''}>
                <option value="">Around the clock</option>
                {(schedules.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </NativeSelect>
            </label>
            <Button type="submit" className="justify-self-start" disabled={save.isPending}>Save policy</Button>
          </form>
        ))}
      </CardContent>
    </Card>
  );
}

export function SalesSettings() {
  const canStages = useCan('opportunities.manage');
  const canSla = useCan('tickets.manage', 'org');
  return (
    <>
      <PageHeader title="Sales & support" description="Pipeline stages and support SLA targets." />
      <div className="grid gap-6">
        {canStages ? <Stages /> : null}
        {canSla ? <SlaPolicies /> : null}
      </div>
    </>
  );
}
