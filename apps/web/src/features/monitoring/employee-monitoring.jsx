'use client';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/common/states';
import { useCan } from '@/features/session/session-provider';
import { api } from '@/lib/api';
import { CONSENT_LABEL, PAUSE_REASON_LABEL } from './labels';
import { DeviceList, PolicySummary } from './my-monitoring';
import { useAgents, useEffectivePolicy, useMonitoringMutation } from './queries';

const SOURCE_LABEL = { ORG: 'the organization policy', TEAM: 'a team policy', MEMBER: 'a personal policy' };

/** Profile → App Settings: the policy in force for this person and their connected devices. */
export function EmployeeAppSettings({ employeeId }) {
  const effective = useEffectivePolicy(employeeId);
  const canSeeDevices = useCan('monitoring.agents.manage');
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-2">
          <div>
            <CardTitle>Screenshot monitoring</CardTitle>
            <CardDescription>{effective.data ? `From ${SOURCE_LABEL[effective.data.source]}${effective.data.policy ? ` (${effective.data.policy.name})` : ''}` : ' '}</CardDescription>
          </div>
          {effective.data ? <Badge tone={CONSENT_LABEL[effective.data.consent].tone}>{CONSENT_LABEL[effective.data.consent].label}</Badge> : null}
        </CardHeader>
        <CardContent>
          {effective.isPending ? (
            <Skeleton className="h-32" />
          ) : effective.error ? (
            <ErrorState error={effective.error} />
          ) : (
            <div className="grid gap-4">
              {!effective.data.enabled ? <p className="text-sm text-muted-foreground">{PAUSE_REASON_LABEL[effective.data.reason]}</p> : null}
              <PolicySummary settings={effective.data.settings} />
            </div>
          )}
        </CardContent>
      </Card>
      {canSeeDevices ? <EmployeeDevices employeeId={employeeId} /> : null}
    </div>
  );
}

function EmployeeDevices({ employeeId }) {
  const agents = useAgents(employeeId);
  const revoke = useMonitoringMutation((agent) => api.post(`/monitoring/agents/${agent.id}/revoke`), { success: 'Device disconnected' });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Desktop apps</CardTitle>
      </CardHeader>
      <CardContent>
        {agents.isPending ? (
          <Skeleton className="h-24" />
        ) : agents.error ? (
          <ErrorState error={agents.error} title={agents.error.status === 403 ? 'You cannot manage this person’s devices' : undefined} />
        ) : (
          <DeviceList agents={agents.data} onRevoke={(a) => revoke.mutate(a)} revoking={revoke.isPending} />
        )}
      </CardContent>
    </Card>
  );
}
