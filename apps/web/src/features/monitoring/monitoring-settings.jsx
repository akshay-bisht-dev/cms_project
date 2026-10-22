'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useForm, useWatch } from 'react-hook-form';
import { Lock, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, NativeSelect, Textarea } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
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
import { FormField } from '@/components/common/form-field';
import { PageHeader } from '@/components/common/page-header';
import { EmptyState, ErrorState } from '@/components/common/states';
import { useEmployees, useTeams } from '@/features/employees/queries';
import { useProjects } from '@/features/projects/queries';
import { useCan } from '@/features/session/session-provider';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { describeInterval } from './labels';
import { DeviceList } from './my-monitoring';
import { monitoringKeys, useAgents, useMonitoringMutation, usePolicies } from './queries';

const toForm = (v) => ({ ...v, excludedApps: (v.excludedApps ?? []).join('\n'), intervalMin: v.intervalS / 60, minMin: v.minIntervalS / 60, maxMin: v.maxIntervalS / 60 });

function fromForm(values, isOrg) {
  const body = {
    captureEnabled: values.captureEnabled,
    intervalS: Math.round(Number(values.intervalMin) * 60),
    blur: values.blur,
    captureMode: values.captureMode,
    excludedApps: values.excludedApps.split('\n').map((s) => s.trim()).filter(Boolean),
    idleDetectionEnabled: values.idleDetectionEnabled,
    retentionDays: Number(values.retentionDays),
    noticeText: values.noticeText,
  };
  if (isOrg) Object.assign(body, { minIntervalS: Math.round(Number(values.minMin) * 60), maxIntervalS: Math.round(Number(values.maxMin) * 60) });
  return body;
}

const Check = ({ label, ...props }) => (
  <label className="flex items-center gap-2 text-sm">
    <input type="checkbox" className="size-4 accent-[var(--primary)]" {...props} />
    {label}
  </label>
);

/** Settings fields shared by the organization policy and team/member policies. */
function SettingsFields({ form, isOrg }) {
  const { register } = form;
  return (
    <div className="grid gap-4">
      <Check label="Take screenshots" {...register('captureEnabled')} />
      <div className="grid gap-4 sm:grid-cols-3">
        <FormField label="Interval (minutes)" required>
          {(aria) => <Input type="number" min={1} step="any" required {...aria} {...register('intervalMin')} />}
        </FormField>
        {isOrg ? (
          <>
            <FormField label="Minimum allowed (min)" hint="Team and member policies are clamped to this range">
              {(aria) => <Input type="number" min={1} step="any" required {...aria} {...register('minMin')} />}
            </FormField>
            <FormField label="Maximum allowed (min)">
              {(aria) => <Input type="number" min={1} step="any" required {...aria} {...register('maxMin')} />}
            </FormField>
          </>
        ) : null}
        <FormField label="Keep for (days)" required hint={isOrg ? 'Lower-level policies can only shorten this' : undefined}>
          {(aria) => <Input type="number" min={1} max={3650} required {...aria} {...register('retentionDays')} />}
        </FormField>
        <FormField label="Screens">
          {(aria) => (
            <NativeSelect {...aria} {...register('captureMode')}>
              <option value="ACTIVE_SCREEN">Only the screen in use</option>
              <option value="ALL_SCREENS">All screens</option>
            </NativeSelect>
          )}
        </FormField>
      </div>
      <div className="flex flex-wrap gap-6">
        <Check label="Blur screenshots" {...register('blur')} />
        <Check label="Record idle duration (never input contents)" {...register('idleDetectionEnabled')} />
      </div>
      <FormField label="Excluded apps" hint="One per line. Nothing is captured while one of these is in front.">
        {(aria) => <Textarea rows={3} {...aria} {...register('excludedApps')} />}
      </FormField>
      <FormField label="Notice shown to employees" required hint="Employees must acknowledge it again whenever it or a setting above changes.">
        {(aria) => <Textarea rows={5} required minLength={40} {...aria} {...register('noticeText')} />}
      </FormField>
    </div>
  );
}

function PublishDialog({ policy, onClose }) {
  const isOrg = policy.scopeLevel === 'ORG';
  const form = useForm({ defaultValues: toForm(policy.currentVersion) });
  const publish = useMonitoringMutation((body) => api.post(`/monitoring/policies/${policy.id}/versions`, body), { success: 'New version published', onSuccess: onClose });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit {policy.name}</DialogTitle>
          <DialogDescription>Publishing creates version {policy.currentVersion.versionNo + 1}. Existing screenshots keep the version they were taken under.</DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit((v) => publish.mutate(fromForm(v, isOrg)))} className="grid gap-4">
          <SettingsFields form={form} isOrg={isOrg} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={publish.isPending}>
              Publish
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function NewPolicyDialog({ orgVersion, onClose }) {
  const form = useForm({ defaultValues: { name: '', scopeLevel: 'TEAM', ...toForm(orgVersion) } });
  const create = useMonitoringMutation((body) => api.post('/monitoring/policies', body), { success: 'Policy created', onSuccess: onClose });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New policy</DialogTitle>
          <DialogDescription>Starts from the organization’s settings. Assign it to teams or people afterwards.</DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit((v) => create.mutate({ name: v.name, scopeLevel: v.scopeLevel, settings: fromForm(v, false) }))} className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Name" required>
              {(aria) => <Input required maxLength={120} {...aria} {...form.register('name')} />}
            </FormField>
            <FormField label="Applies to">
              {(aria) => (
                <NativeSelect {...aria} {...form.register('scopeLevel')}>
                  <option value="TEAM">Teams</option>
                  <option value="MEMBER">Individual people</option>
                </NativeSelect>
              )}
            </FormField>
          </div>
          <SettingsFields form={form} isOrg={false} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AssignDialog({ policy, onClose }) {
  const teams = useTeams();
  const people = useEmployees({ status: 'ACTIVE', limit: 100, sort: 'name' });
  const [targets, setTargets] = useState(() => policy.assignments.filter((a) => a.id).map((a) => ({ type: a.type, id: a.id, priority: a.priority })));
  const options = policy.scopeLevel === 'TEAM' ? (teams.data ?? []).map((t) => [t.id, t.name]) : (people.data?.data ?? []).map((p) => [p.employeeId, p.name]);
  const save = useMonitoringMutation(() => api.put(`/monitoring/policies/${policy.id}/assignments`, { targets }), { success: 'Assignments saved', onSuccess: onClose });
  const selected = new Map(targets.map((t) => [t.id, t]));
  const toggle = (id, on) => setTargets((ts) => (on ? [...ts, { type: policy.scopeLevel, id, priority: 0 }] : ts.filter((t) => t.id !== id)));
  const setPriority = (id, priority) => setTargets((ts) => ts.map((t) => (t.id === id ? { ...t, priority } : t)));
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Assign {policy.name}</DialogTitle>
          <DialogDescription>
            A person’s own policy wins over a team policy. Between teams, the higher priority wins; on a tie, the less invasive policy wins.
          </DialogDescription>
        </DialogHeader>
        <fieldset className="grid gap-2">
          <legend className="sr-only">{policy.scopeLevel === 'TEAM' ? 'Teams' : 'People'}</legend>
          {options.map(([id, name]) => (
            <div key={id} className="flex items-center justify-between gap-3">
              <Check label={name} checked={selected.has(id)} onChange={(e) => toggle(id, e.target.checked)} />
              {policy.scopeLevel === 'TEAM' && selected.has(id) ? (
                <Input type="number" min={0} max={1000} aria-label={`Priority for ${name}`} className="w-24" value={selected.get(id).priority} onChange={(e) => setPriority(id, Number(e.target.value))} />
              ) : null}
            </div>
          ))}
        </fieldset>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function VersionHistory({ policyId }) {
  const versions = useQuery({ queryKey: monitoringKeys.versions(policyId), queryFn: async () => (await api.get(`/monitoring/policies/${policyId}/versions`)).data });
  if (versions.isPending) return <Skeleton className="h-16" />;
  if (versions.error) return <ErrorState error={versions.error} />;
  return (
    <ul className="space-y-1 text-sm">
      {versions.data.map((v) => (
        <li key={v.id} className="flex flex-wrap justify-between gap-2">
          <span>
            v{v.versionNo} · {v.captureEnabled ? describeInterval(v.intervalS) : 'capture off'} · {v.retentionDays} days
          </span>
          <span className="text-muted-foreground">
            {v.publishedBy ?? 'System'} · {formatDate(v.publishedAt, { withTime: true })}
          </span>
        </li>
      ))}
    </ul>
  );
}

function PolicySettingsSummary({ version }) {
  return (
    <p className="text-sm text-muted-foreground">
      {version.captureEnabled ? `Captures ${describeInterval(version.intervalS)}` : 'No captures'} · {version.captureMode === 'ALL_SCREENS' ? 'all screens' : 'active screen'}
      {version.blur ? ' · blurred' : ''} · kept {version.retentionDays} days
      {version.excludedApps.length ? ` · ${version.excludedApps.length} excluded app${version.excludedApps.length === 1 ? '' : 's'}` : ''}
    </p>
  );
}

function OrgPolicyCard({ policy, canManage }) {
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [history, setHistory] = useState(false);
  const toggle = useMonitoringMutation((isActive) => api.patch(`/monitoring/policies/${policy.id}`, { isActive }), {
    success: (_d, on) => (on ? 'Monitoring turned on' : 'Monitoring turned off for everyone'),
  });
  const v = policy.currentVersion;
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>Organization policy</CardTitle>
          <CardDescription>The master switch and the defaults for everyone. Version {v.versionNo}.</CardDescription>
        </div>
        <label className="flex items-center gap-2 text-sm font-medium">
          <Switch checked={policy.isActive} disabled={!canManage || toggle.isPending} onCheckedChange={(on) => (on ? setConfirm(true) : toggle.mutate(false))} aria-label="Screenshot monitoring" />
          {policy.isActive ? 'On' : 'Off'}
        </label>
      </CardHeader>
      <CardContent className="grid gap-4">
        <PolicySettingsSummary version={v} />
        <p className="text-sm text-muted-foreground">
          Allowed interval range: {describeInterval(v.minIntervalS)} to {describeInterval(v.maxIntervalS)}.
        </p>
        <div className="flex flex-wrap gap-2">
          {canManage ? (
            <Button size="sm" onClick={() => setEditing(true)}>
              Edit settings
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" aria-expanded={history} onClick={() => setHistory((h) => !h)}>
            {history ? 'Hide history' : 'Version history'}
          </Button>
        </div>
        {history ? <VersionHistory policyId={policy.id} /> : null}
      </CardContent>
      {editing ? <PublishDialog policy={policy} onClose={() => setEditing(false)} /> : null}
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogTitle>Turn on screenshot monitoring?</AlertDialogTitle>
          <AlertDialogDescription>
            Nobody is captured until they have read and acknowledged the notice, connected the desktop app and granted their operating system’s screen-recording permission.
            Make sure monitoring is lawful where your employees work.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => toggle.mutate(true)}>Turn on</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function ChildPolicies({ policies, orgVersion, canManage }) {
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState(null);
  const [assigning, setAssigning] = useState(null);
  const toggle = useMonitoringMutation(({ id, isActive }) => api.patch(`/monitoring/policies/${id}`, { isActive }), { success: 'Policy updated' });
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-2">
        <div>
          <CardTitle>Team and individual policies</CardTitle>
          <CardDescription>Override the organization defaults for specific teams or people.</CardDescription>
        </div>
        {canManage ? (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus aria-hidden /> New policy
          </Button>
        ) : null}
      </CardHeader>
      <CardContent>
        {policies.length === 0 ? (
          <p className="text-sm text-muted-foreground">Everyone follows the organization policy.</p>
        ) : (
          <ul className="divide-y">
            {policies.map((p) => (
              <li key={p.id} className="grid gap-2 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{p.name}</span>
                  <Badge>{p.scopeLevel === 'TEAM' ? 'Teams' : 'People'}</Badge>
                  {!p.isActive ? <Badge tone="warning">Inactive</Badge> : null}
                  {canManage ? (
                    <span className="ml-auto flex gap-2">
                      <Button size="sm" variant="outline" onClick={() => setAssigning(p)}>
                        Assign
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setEditing(p)}>
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" disabled={toggle.isPending} onClick={() => toggle.mutate({ id: p.id, isActive: !p.isActive })}>
                        {p.isActive ? 'Deactivate' : 'Activate'}
                      </Button>
                    </span>
                  ) : null}
                </div>
                <PolicySettingsSummary version={p.currentVersion} />
                <p className="text-xs text-muted-foreground">
                  {p.assignments.length ? `Applies to: ${p.assignments.map((a) => (a.type === 'TEAM' ? `${a.name} (priority ${a.priority})` : a.name)).join(', ')}` : 'Not assigned to anyone yet'}
                </p>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      {creating ? <NewPolicyDialog orgVersion={orgVersion} onClose={() => setCreating(false)} /> : null}
      {editing ? <PublishDialog policy={editing} onClose={() => setEditing(null)} /> : null}
      {assigning ? <AssignDialog policy={assigning} onClose={() => setAssigning(null)} /> : null}
    </Card>
  );
}

function AllDevices() {
  const agents = useAgents();
  const revoke = useMonitoringMutation((agent) => api.post(`/monitoring/agents/${agent.id}/revoke`), { success: 'Device disconnected' });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Desktop apps</CardTitle>
        <CardDescription>Every connected device. Disconnecting one stops it immediately.</CardDescription>
      </CardHeader>
      <CardContent>
        {agents.isPending ? <Skeleton className="h-24" /> : agents.error ? <ErrorState error={agents.error} /> : <DeviceList agents={agents.data} onRevoke={(a) => revoke.mutate(a)} revoking={revoke.isPending} />}
      </CardContent>
    </Card>
  );
}

function HoldDialog({ onClose }) {
  const people = useEmployees({ status: 'ACTIVE', limit: 100, sort: 'name' });
  const projects = useProjects();
  const form = useForm({ defaultValues: { name: '', reason: '', type: 'MEMBER', id: '', fromDate: '', toDate: '' } });
  const type = useWatch({ control: form.control, name: 'type' });
  const create = useMonitoringMutation((body) => api.post('/monitoring/legal-holds', body), { success: 'Legal hold placed', onSuccess: onClose });
  const options = type === 'MEMBER' ? (people.data?.data ?? []).map((p) => [p.employeeId, p.name]) : (projects.data ?? []).map((p) => [p.id, `${p.code} · ${p.name}`]);
  function submit(v) {
    create.mutate({ name: v.name, reason: v.reason, targets: [{ type: v.type, id: v.id, ...(v.fromDate ? { fromDate: v.fromDate } : {}), ...(v.toDate ? { toDate: v.toDate } : {}) }] });
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Place a legal hold</DialogTitle>
          <DialogDescription>Matching screenshots are exempt from retention and cannot be deleted until the hold is released.</DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(submit)} className="grid gap-4">
          <FormField label="Name" required>
            {(aria) => <Input required maxLength={120} {...aria} {...form.register('name')} />}
          </FormField>
          <FormField label="Reason" required>
            {(aria) => <Textarea rows={2} required maxLength={1000} {...aria} {...form.register('reason')} />}
          </FormField>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Covers">
              {(aria) => (
                <NativeSelect {...aria} {...form.register('type', { onChange: () => form.setValue('id', '') })}>
                  <option value="MEMBER">A person</option>
                  <option value="PROJECT">A project</option>
                </NativeSelect>
              )}
            </FormField>
            <FormField label="Which" required>
              {(aria) => (
                <NativeSelect required {...aria} {...form.register('id')}>
                  <option value="">Choose…</option>
                  {options.map(([id, name]) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
                </NativeSelect>
              )}
            </FormField>
            <FormField label="From (UTC date)" hint="Optional">
              {(aria) => <Input type="date" {...aria} {...form.register('fromDate')} />}
            </FormField>
            <FormField label="To (UTC date)" hint="Optional">
              {(aria) => <Input type="date" {...aria} {...form.register('toDate')} />}
            </FormField>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              Place hold
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function LegalHolds() {
  const [creating, setCreating] = useState(false);
  const holds = useQuery({ queryKey: monitoringKeys.holds, queryFn: async () => (await api.get('/monitoring/legal-holds')).data });
  const release = useMonitoringMutation((id) => api.post(`/monitoring/legal-holds/${id}/release`), { success: 'Hold released' });
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-2">
        <div>
          <CardTitle>Legal holds</CardTitle>
          <CardDescription>{holds.data ? `${holds.data.heldScreenshots} screenshots currently held.` : 'Preserve screenshots for an investigation or litigation.'}</CardDescription>
        </div>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Lock aria-hidden /> Place hold
        </Button>
      </CardHeader>
      <CardContent>
        {holds.isPending ? (
          <Skeleton className="h-16" />
        ) : holds.error ? (
          <ErrorState error={holds.error} />
        ) : holds.data.holds.length === 0 ? (
          <EmptyState icon={Lock} title="No legal holds" description="Screenshots follow their normal retention." />
        ) : (
          <ul className="divide-y">
            {holds.data.holds.map((h) => (
              <li key={h.id} className="flex flex-wrap items-start gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {h.name} {h.releasedAt ? <Badge>Released {formatDate(h.releasedAt)}</Badge> : <Badge tone="warning">Active</Badge>}
                  </p>
                  <p className="text-sm text-muted-foreground">{h.reason}</p>
                  <p className="text-xs text-muted-foreground">
                    {h.targets.map((t) => `${t.name}${t.fromDate || t.toDate ? ` (${formatDate(t.fromDate?.slice(0, 10))} – ${formatDate(t.toDate?.slice(0, 10))})` : ''}`).join(', ')} · placed by {h.createdBy ?? 'unknown'} on {formatDate(h.createdAt)}
                  </p>
                </div>
                {!h.releasedAt ? (
                  <Button size="sm" variant="outline" disabled={release.isPending} onClick={() => release.mutate(h.id)}>
                    Release
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      {creating ? <HoldDialog onClose={() => setCreating(false)} /> : null}
    </Card>
  );
}

function DeletionLog() {
  const [range] = useState(() => {
    const to = new Date();
    return { from: new Date(to.getTime() - 30 * 86400_000).toISOString(), to: new Date(to.getTime() + 60_000).toISOString() };
  });
  const log = useQuery({ queryKey: monitoringKeys.deletions(range), queryFn: async () => (await api.get('/monitoring/deletions', { query: range })).data });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Deleted screenshots (last 30 days)</CardTitle>
        <CardDescription>Metadata only. The images themselves are gone.</CardDescription>
      </CardHeader>
      <CardContent>
        {log.isPending ? (
          <Skeleton className="h-16" />
        ) : log.error ? (
          <ErrorState error={log.error} />
        ) : log.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing was deleted.</p>
        ) : (
          <ul className="max-h-64 space-y-1 overflow-y-auto text-sm">
            {log.data.map((d) => (
              <li key={d.screenshotId} className="flex flex-wrap justify-between gap-2">
                <span>
                  {d.employee.name} · captured {formatDate(d.capturedAt, { withTime: true })}
                </span>
                <span className="text-muted-foreground">
                  {d.reason === 'RETENTION' ? 'Retention' : `Deleted by ${d.actor?.name ?? 'unknown'}`} · {formatDate(d.deletedAt, { withTime: true })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function MonitoringSettings() {
  const canManage = useCan('monitoring.policy.manage');
  const canReadAll = useCan('monitoring.policy.read', 'org');
  const canHold = useCan('monitoring.legalhold.manage');
  const canDelete = useCan('monitoring.screenshots.delete');
  const canDevices = useCan('monitoring.agents.manage', 'org');
  const policies = usePolicies(canReadAll);

  if (!canReadAll) return <EmptyState title="No access" description="You need permission to view monitoring policies." />;
  if (policies.isPending) return <Skeleton className="h-96" role="status" aria-label="Loading monitoring settings" />;
  if (policies.error) return <ErrorState error={policies.error} onRetry={() => policies.refetch()} />;
  const org = policies.data.find((p) => p.scopeLevel === 'ORG');
  const children = policies.data.filter((p) => p.scopeLevel !== 'ORG');

  return (
    <>
      <PageHeader title="Screenshot monitoring" description="Transparent, consent-based capture by the desktop app. Changes are audited." />
      <div className="grid gap-6">
        <OrgPolicyCard policy={org} canManage={canManage} />
        <ChildPolicies policies={children} orgVersion={org.currentVersion} canManage={canManage} />
        {canDevices ? <AllDevices /> : null}
        {canHold ? <LegalHolds /> : null}
        {canDelete ? <DeletionLog /> : null}
      </div>
    </>
  );
}
