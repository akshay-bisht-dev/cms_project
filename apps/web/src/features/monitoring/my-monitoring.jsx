'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Camera, CameraOff, Laptop, MonitorSmartphone, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { PageHeader } from '@/components/common/page-header';
import { EmptyState, ErrorState } from '@/components/common/states';
import { formatDate, formatRelative } from '@/lib/format';
import { api } from '@/lib/api';
import { AGENT_OFFLINE_AFTER_MS, AGENT_STATE_LABEL, CONSENT_LABEL, PAUSE_REASON_LABEL, SCOPE_LABEL, describeInterval } from './labels';
import { useMonitoringMutation, useMyMonitoring } from './queries';

export function PolicySummary({ settings }) {
  if (!settings) return null;
  const rows = [
    ['How often', settings.captureEnabled ? `${describeInterval(settings.intervalS)}, at a random moment within each interval` : 'Never: this policy does not take screenshots'],
    ['What', settings.captureMode === 'ALL_SCREENS' ? 'All connected screens' : 'Only the screen you are using'],
    ['Blur', settings.blur ? 'Screenshots are blurred before upload' : 'Not blurred'],
    ['Excluded apps', settings.excludedApps.length ? settings.excludedApps.join(', ') : 'None'],
    ['Idle time', settings.idleDetectionEnabled ? 'How long there was no input (never what you typed)' : 'Not recorded'],
    ['Kept for', `${settings.retentionDays} days, then deleted automatically`],
  ];
  return (
    <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
      {rows.map(([term, value]) => (
        <div key={term} className="contents">
          <dt className="text-muted-foreground">{term}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function AgentStatus({ agent, now }) {
  if (agent.status === 'REVOKED') return <Badge>Disconnected</Badge>;
  const offline = !agent.lastSeenAt || now - new Date(agent.lastSeenAt).getTime() > AGENT_OFFLINE_AFTER_MS;
  if (offline) return <Badge tone="warning">Offline</Badge>;
  const state = agent.lastState?.state;
  return <Badge tone={state === 'CAPTURING' ? 'success' : state === 'ERROR' || state === 'PERMISSION_MISSING' ? 'danger' : 'info'}>{AGENT_STATE_LABEL[state] ?? 'Online'}</Badge>;
}

function PairingDialog({ onClose }) {
  const [pairing, setPairing] = useState(null);
  const [error, setError] = useState(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    api.post('/monitoring/me/pairing-codes').then(({ data }) => setPairing(data), setError);
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const remaining = pairing ? Math.max(0, Math.round((new Date(pairing.expiresAt).getTime() - now) / 1000)) : null;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect the desktop app</DialogTitle>
          <DialogDescription>Open Orbit Desktop on your computer and enter this one-time code.</DialogDescription>
        </DialogHeader>
        {error ? (
          <ErrorState error={error} />
        ) : !pairing ? (
          <Skeleton className="h-16" />
        ) : (
          <div className="grid gap-3 text-center">
            <p className="font-mono text-3xl font-semibold tracking-[0.2em]" aria-label={`Pairing code ${pairing.code.split('').join(' ')}`}>
              {pairing.code}
            </p>
            <p className="text-sm text-muted-foreground" aria-live="polite">
              {remaining > 0 ? `Expires in ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}` : 'This code has expired. Close this window and create a new one.'}
            </p>
          </div>
        )}
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
          <li>The app asks your operating system for screen-recording permission. Capture never starts without it.</li>
          <li>Its tray icon always shows whether capture is on, paused, or off.</li>
          <li>You can disconnect the device here at any time.</li>
        </ol>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DeviceList({ agents, onRevoke, revoking }) {
  // Captured once per mount; the list is refetched (and remounted) as devices check in.
  const [now] = useState(() => Date.now());
  if (!agents.length) {
    return <EmptyState icon={MonitorSmartphone} title="No desktop app connected" description="Screenshots are only taken by the desktop app. The web app never captures your screen." />;
  }
  return (
    <ul className="divide-y">
      {agents.map((agent) => (
        <li key={agent.id} className="flex flex-wrap items-center gap-3 py-3">
          <Laptop aria-hidden className="size-5 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="font-medium">
              {agent.deviceName}
              {agent.employee ? <span className="text-muted-foreground"> · {agent.employee.name}</span> : null}
            </p>
            <p className="text-xs text-muted-foreground">
              {agent.os} {agent.osVersion ?? ''} · app {agent.agentVersion ?? 'unknown'} ·{' '}
              {agent.status === 'REVOKED' ? `disconnected ${formatDate(agent.revokedAt, { withTime: true })}` : agent.lastSeenAt ? `last seen ${formatRelative(agent.lastSeenAt)}` : 'never connected'}
            </p>
          </div>
          <AgentStatus agent={agent} now={now} />
          {agent.status === 'ACTIVE' && onRevoke ? (
            <Button size="sm" variant="outline" disabled={revoking} onClick={() => onRevoke(agent)}>
              Disconnect
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function MyMonitoringPage() {
  const me = useMyMonitoring();
  const [pairing, setPairing] = useState(false);
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const consent = useMonitoringMutation((action) => api.post('/monitoring/me/consent', { action, policyVersionId: me.data.version.id }), {
    success: (_d, action) => (action === 'ACKNOWLEDGED' ? 'Notice acknowledged' : 'Acknowledgement withdrawn; capture has stopped'),
  });
  const revoke = useMonitoringMutation((agent) => api.post(`/monitoring/agents/${agent.id}/revoke`), { success: 'Device disconnected' });

  if (me.isPending) return <Skeleton className="h-96" role="status" aria-label="Loading monitoring status" />;
  if (me.error) return <ErrorState error={me.error} onRetry={() => me.refetch()} />;
  const data = me.data;
  const consentInfo = CONSENT_LABEL[data.consent.status];
  const active = data.enabled && data.consent.status === 'ACKNOWLEDGED';
  const counts = data.last7Days ?? {};

  return (
    <>
      <PageHeader
        title="My monitoring"
        description="Exactly what is captured, when, who can see it, and for how long."
        actions={
          <Button variant="outline" asChild>
            <Link href="/screenshots">View my screenshots</Link>
          </Button>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="grid content-start gap-6">
          <Card>
            <CardHeader className="flex-row items-start gap-3">
              {active ? <Camera aria-hidden className="mt-1 size-6 text-success" /> : <CameraOff aria-hidden className="mt-1 size-6 text-muted-foreground" />}
              <div>
                <CardTitle>{active ? 'Screenshots are taken while you are clocked in and working' : 'No screenshots are being taken'}</CardTitle>
                <CardDescription>
                  {active
                    ? 'Never while you are on a break or clocked out. The desktop app’s tray icon shows the current state.'
                    : PAUSE_REASON_LABEL[!data.enabled ? data.reason : data.consent.status === 'WITHDRAWN' ? 'CONSENT_WITHDRAWN' : 'CONSENT_REQUIRED']}
                </CardDescription>
              </div>
            </CardHeader>
          </Card>

          <Card>
            <CardHeader className="flex-row items-start justify-between gap-2">
              <div>
                <CardTitle>Monitoring notice</CardTitle>
                <CardDescription>{data.version ? `Version ${data.version.versionNo}, published ${formatDate(data.version.publishedAt)}` : 'Not configured'}</CardDescription>
              </div>
              <Badge tone={consentInfo.tone}>{consentInfo.label}</Badge>
            </CardHeader>
            {data.version ? (
              <CardContent className="grid gap-5">
                <p className="text-sm whitespace-pre-line">{data.version.noticeText}</p>
                <PolicySummary settings={data.settings} />
                <p className="text-sm text-muted-foreground">
                  Never captured: keystrokes, clipboard, microphone, webcam, or the contents of websites and messages.
                </p>
                <div className="flex flex-wrap items-center gap-3">
                  {data.consent.status !== 'ACKNOWLEDGED' ? (
                    <Button disabled={consent.isPending} onClick={() => consent.mutate('ACKNOWLEDGED')}>
                      <ShieldCheck aria-hidden /> I have read this notice
                    </Button>
                  ) : (
                    <Button variant="outline" disabled={consent.isPending} onClick={() => setConfirmWithdraw(true)}>
                      Withdraw acknowledgement
                    </Button>
                  )}
                  {data.consent.at ? <span className="text-xs text-muted-foreground">Last change {formatDate(data.consent.at, { withTime: true })}</span> : null}
                </div>
              </CardContent>
            ) : null}
          </Card>

          <Card>
            <CardHeader className="flex-row items-start justify-between gap-2">
              <div>
                <CardTitle>Your devices</CardTitle>
                <CardDescription>Desktop apps connected to your account.</CardDescription>
              </div>
              <Button size="sm" onClick={() => setPairing(true)}>
                Connect desktop app
              </Button>
            </CardHeader>
            <CardContent>
              <DeviceList agents={data.agents} onRevoke={(agent) => revoke.mutate(agent)} revoking={revoke.isPending} />
            </CardContent>
          </Card>
        </div>

        <div className="grid content-start gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Who can see your screenshots</CardTitle>
              <CardDescription>You can always see your own. Every view and download is logged, and you can see that log.</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2 text-sm">
                {data.viewers.map((v) => (
                  <li key={`${v.role}-${v.scope}`}>
                    <span className="font-medium">{v.role}</span> <span className="text-muted-foreground">— {SCOPE_LABEL[v.scope] ?? v.scope}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Last 7 days</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <dt className="text-muted-foreground">Captured</dt>
                  <dd className="text-2xl font-semibold tabular-nums">{(counts.READY ?? 0) + (counts.UPLOADED ?? 0)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Missing or failed</dt>
                  <dd className="text-2xl font-semibold tabular-nums">{(counts.FAILED ?? 0) + (counts.REJECTED ?? 0)}</dd>
                </div>
              </dl>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Your acknowledgements</CardTitle>
            </CardHeader>
            <CardContent>
              {data.consentHistory.length ? (
                <ul className="space-y-1 text-sm">
                  {data.consentHistory.map((h) => (
                    <li key={`${h.at}-${h.action}`} className="flex justify-between gap-2">
                      <span>{h.action === 'ACKNOWLEDGED' ? 'Acknowledged' : 'Withdrawn'}</span>
                      <span className="text-muted-foreground">{formatDate(h.at, { withTime: true })}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">None yet.</p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {pairing ? <PairingDialog onClose={() => setPairing(false)} /> : null}
      <AlertDialog open={confirmWithdraw} onOpenChange={setConfirmWithdraw}>
        <AlertDialogContent>
          <AlertDialogTitle>Withdraw your acknowledgement?</AlertDialogTitle>
            <AlertDialogDescription>
              Screenshot capture stops immediately on all your devices. Whether monitoring is a condition of your role is a matter for your employer’s HR team, not this app.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => consent.mutate('WITHDRAWN')}>Withdraw</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
