'use client';

import { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { Copy, History, KeyRound, Webhook } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, NativeSelect } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FormField } from '@/components/common/form-field';
import { PageHeader } from '@/components/common/page-header';
import { EmptyState, ErrorState } from '@/components/common/states';
import { DataTable } from '@/components/data-tables/data-table';
import { useCan, useMe } from '@/features/session/session-provider';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useAction } from '@/features/crm/queries';

const keys = [['integrations']];
const DELIVERY_TONE = { SUCCEEDED: 'success', PENDING: 'info', FAILED: 'danger' };

/** Shows a secret exactly once; closing the dialog discards it from the page. */
function SecretDialog({ title, description, value, onClose }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success('Copied');
    } catch {
      toast.error('Copy failed — select the text and copy it');
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{description} It will not be shown again.</DialogDescription></DialogHeader>
        <div className="flex items-center gap-2">
          <Input readOnly aria-label="Secret value" value={value} className="font-mono text-xs" onFocus={(e) => e.target.select()} />
          <Button variant="outline" onClick={copy}><Copy aria-hidden /> Copy</Button>
        </div>
        <DialogFooter><Button onClick={onClose}>I have stored it</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function WebhookDialog({ hook, events, onClose, onSecret }) {
  const form = useForm({ defaultValues: { url: hook?.url ?? '', description: hook?.description ?? '', events: hook?.events ?? [] } });
  const save = useAction(
    (v) => {
      const body = { url: v.url, events: v.events, description: v.description || (hook ? null : undefined) };
      return hook ? api.patch(`/webhooks/${hook.id}`, body) : api.post('/webhooks', body);
    },
    {
      success: hook ? 'Webhook saved' : null,
      keys,
      onSuccess: (res) => {
        onClose();
        if (!hook) onSecret(res.data.secret);
      },
    },
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader><DialogTitle>{hook ? 'Edit webhook' : 'Add a webhook'}</DialogTitle><DialogDescription>Events are POSTed as JSON and signed with HMAC-SHA256. Only public HTTPS addresses are accepted.</DialogDescription></DialogHeader>
        <form onSubmit={form.handleSubmit((v) => (v.events.length ? save.mutate(v) : toast.error('Choose at least one event')))} className="grid gap-4">
          <FormField label="Endpoint URL" required>{(a) => <Input type="url" required placeholder="https://example.com/hooks/orbit" {...a} {...form.register('url')} />}</FormField>
          <FormField label="Description">{(a) => <Input maxLength={200} {...a} {...form.register('description')} />}</FormField>
          <fieldset className="grid gap-2 sm:grid-cols-2">
            <legend className="mb-2 text-sm font-medium">Events</legend>
            {events.map((e) => (
              <label key={e.type} className="flex items-start gap-2 text-sm">
                <input type="checkbox" value={e.type} className="mt-0.5 size-4 accent-[var(--primary)]" {...form.register('events')} />
                <span><span className="font-mono text-xs">{e.type}</span><span className="block text-muted-foreground">{e.description}</span></span>
              </label>
            ))}
          </fieldset>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={save.isPending}>Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Deliveries({ hook, onClose }) {
  const rows = useQuery({ queryKey: ['integrations', 'deliveries', hook.id], queryFn: async () => (await api.get(`/webhooks/${hook.id}/deliveries`)).data });
  const replay = useAction((id) => api.post(`/webhooks/${hook.id}/deliveries/${id}/replay`), { success: 'Queued for sending', keys });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader><DialogTitle>Deliveries</DialogTitle><DialogDescription className="break-all">{hook.url} · the latest 100</DialogDescription></DialogHeader>
        <DataTable
          caption="Webhook deliveries"
          scrollable
          rows={rows.data ?? []}
          isPending={rows.isPending}
          error={rows.error}
          onRetry={() => rows.refetch()}
          empty={<EmptyState icon={Webhook} title="Nothing sent yet" description="Send a test event to check your endpoint." />}
          columns={[
            { key: 'at', header: 'Created', cell: (d) => formatDate(d.createdAt, { withTime: true }) },
            { key: 'event', header: 'Event', cell: (d) => <span className="font-mono text-xs">{d.eventType}{d.replayOfId ? ' (replay)' : ''}</span> },
            { key: 'status', header: 'Status', cell: (d) => <Badge tone={DELIVERY_TONE[d.status] ?? 'neutral'}>{d.status.toLowerCase()}</Badge> },
            { key: 'result', header: 'Result', cell: (d) => <span className="text-xs">{d.statusCode ? `HTTP ${d.statusCode}` : ''}{d.responseMs !== null ? ` · ${d.responseMs} ms` : ''}{d.error ? <span className="block text-destructive">{d.error}</span> : null}{d.status === 'PENDING' && d.nextRetryAt ? <span className="block text-muted-foreground">attempt {d.attempt + 1} at {formatDate(d.nextRetryAt, { withTime: true })}</span> : null}</span> },
            { key: 'replay', header: <span className="sr-only">Actions</span>, cell: (d) => (d.status === 'PENDING' ? null : <Button size="sm" variant="ghost" disabled={!hook.isActive || replay.isPending} onClick={() => replay.mutate(d.id)}>Replay</Button>) },
          ]}
        />
      </DialogContent>
    </Dialog>
  );
}

function Webhooks() {
  const hooks = useQuery({ queryKey: ['integrations', 'webhooks'], queryFn: async () => (await api.get('/webhooks')).data });
  const events = useQuery({ queryKey: ['integrations', 'events'], queryFn: async () => (await api.get('/webhooks/events')).data, staleTime: Infinity });
  const [editing, setEditing] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [secret, setSecret] = useState(null);
  const toggle = useAction(({ id, isActive }) => api.patch(`/webhooks/${id}`, { isActive }), { keys });
  const ping = useAction((id) => api.post(`/webhooks/${id}/ping`), { success: 'Test event queued', keys });
  const rotate = useAction((id) => api.post(`/webhooks/${id}/rotate-secret`), { keys, onSuccess: (res) => setSecret(res.data.secret) });
  const remove = useAction((id) => api.delete(`/webhooks/${id}`), { success: 'Webhook deleted', keys });
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-2">
        <div><CardTitle>Webhooks</CardTitle><CardDescription>Failed deliveries are retried for about 14 hours; a webhook is switched off after 20 deliveries in a row fail.</CardDescription></div>
        <Button size="sm" disabled={!events.data} onClick={() => setEditing('new')}>Add webhook</Button>
      </CardHeader>
      <CardContent>
        {hooks.isPending ? <Skeleton className="h-20" /> : hooks.error ? <ErrorState error={hooks.error} onRetry={() => hooks.refetch()} /> : hooks.data.length ? (
          <ul className="divide-y text-sm">
            {hooks.data.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center gap-2 py-3">
                <div className="min-w-0 flex-1 basis-64">
                  <p className="font-medium break-all">{h.url}</p>
                  <p className="text-muted-foreground">{h.description ? `${h.description} · ` : ''}{h.events.length} event(s){h.consecutiveFailures ? ` · ${h.consecutiveFailures} failed in a row` : ''}</p>
                  {h.disabledReason ? <p className="text-destructive">{h.disabledReason}</p> : null}
                </div>
                <Badge tone={h.isActive ? 'success' : 'neutral'}>{h.isActive ? 'Active' : 'Off'}</Badge>
                <Button size="sm" variant="ghost" onClick={() => setViewing(h)}>Deliveries</Button>
                <Button size="sm" variant="ghost" disabled={!h.isActive || ping.isPending} onClick={() => ping.mutate(h.id)}>Test</Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(h)}>Edit</Button>
                <Button size="sm" variant="ghost" onClick={() => toggle.mutate({ id: h.id, isActive: !h.isActive })}>{h.isActive ? 'Turn off' : 'Turn on'}</Button>
                <Button size="sm" variant="ghost" onClick={() => window.confirm('Replace the signing secret? Your receiver must switch to the new one.') && rotate.mutate(h.id)}>New secret</Button>
                <Button size="sm" variant="ghost" onClick={() => window.confirm('Delete this webhook and its delivery history?') && remove.mutate(h.id)}>Delete<span className="sr-only"> {h.url}</span></Button>
              </li>
            ))}
          </ul>
        ) : <EmptyState icon={Webhook} title="No webhooks" description="Notify another system when things happen here." />}
      </CardContent>
      {editing ? <WebhookDialog hook={editing === 'new' ? null : editing} events={events.data} onClose={() => setEditing(null)} onSecret={setSecret} /> : null}
      {viewing ? <Deliveries hook={viewing} onClose={() => setViewing(null)} /> : null}
      {secret ? <SecretDialog title="Signing secret" description="Use it to verify the X-Orbit-Signature header on each delivery." value={secret} onClose={() => setSecret(null)} /> : null}
    </Card>
  );
}

function ApiKeyDialog({ onClose, onKey }) {
  const me = useMe();
  const catalog = useQuery({ queryKey: ['permissions'], queryFn: async () => (await api.get('/permissions')).data, staleTime: Infinity });
  const held = new Set((me?.permissions ?? []).map((p) => p.key));
  const form = useForm({ defaultValues: { name: '', expiresInDays: '90', scopes: [] } });
  const create = useAction((v) => api.post('/api-keys', { name: v.name, scopes: v.scopes, ...(v.expiresInDays ? { expiresInDays: Number(v.expiresInDays) } : {}) }), {
    keys,
    onSuccess: (res) => {
      onClose();
      onKey(res.data.key);
    },
  });
  const options = (catalog.data ?? []).filter((p) => held.has(p.key));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader><DialogTitle>Create an API key</DialogTitle><DialogDescription>The key acts with the permissions you pick, limited to what you hold and to the scopes of your roles. Only some endpoints accept API keys (see the API reference).</DialogDescription></DialogHeader>
        <form onSubmit={form.handleSubmit((v) => (v.scopes.length ? create.mutate(v) : toast.error('Choose at least one permission')))} className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Name" required>{(a) => <Input required maxLength={120} placeholder="Payroll sync" {...a} {...form.register('name')} />}</FormField>
            <FormField label="Expires">{(a) => <NativeSelect {...a} {...form.register('expiresInDays')}><option value="30">In 30 days</option><option value="90">In 90 days</option><option value="365">In a year</option><option value="">Never</option></NativeSelect>}</FormField>
          </div>
          <fieldset className="grid max-h-72 gap-2 overflow-y-auto rounded-md border p-3" tabIndex={0} aria-label="Permissions">
            <legend className="sr-only">Permissions</legend>
            {catalog.isPending ? <Skeleton className="h-20" /> : options.map((p) => (
              <label key={p.key} className="flex items-start gap-2 text-sm">
                <input type="checkbox" value={p.key} className="mt-0.5 size-4 accent-[var(--primary)]" {...form.register('scopes')} />
                <span>{p.description} <span className="font-mono text-xs text-muted-foreground">{p.key}</span></span>
              </label>
            ))}
          </fieldset>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={create.isPending}>Create key</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** API keys: my own (`mine`), or every key in the organization for holders of apikeys.manage. */
export function ApiKeys({ mine = false }) {
  const canCreate = useCan('apikeys.manage');
  const list = useQuery({ queryKey: ['integrations', 'api-keys', mine], queryFn: async () => (await api.get('/api-keys', { query: mine ? { mine: 'true' } : {} })).data });
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState(null);
  const revoke = useAction((id) => api.post(`/api-keys/${id}/revoke`), { success: 'Key revoked', keys });
  const now = new Date();
  const state = (k) => (k.revokedAt ? ['Revoked', 'neutral'] : k.expiresAt && new Date(k.expiresAt) <= now ? ['Expired', 'warning'] : ['Active', 'success']);
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-2">
        <div><CardTitle>API keys</CardTitle><CardDescription>Send as <code className="font-mono">Authorization: Bearer orb_…</code>. Limited to 1,000 requests an hour per key.</CardDescription></div>
        {canCreate ? <Button size="sm" onClick={() => setCreating(true)}>Create key</Button> : null}
      </CardHeader>
      <CardContent>
        <DataTable
          caption="API keys"
          scrollable
          rows={list.data ?? []}
          isPending={list.isPending}
          error={list.error}
          onRetry={() => list.refetch()}
          empty={<EmptyState icon={KeyRound} title="No API keys" />}
          columns={[
            { key: 'name', header: 'Name', cell: (k) => <span><span className="font-medium">{k.name}</span> <span className="font-mono text-xs text-muted-foreground">{k.prefix}…</span></span> },
            { key: 'scopes', header: 'Permissions', cell: (k) => <span className="text-xs">{k.scopes.join(', ')}</span>, className: 'hidden md:table-cell' },
            ...(mine ? [] : [{ key: 'by', header: 'Created by', cell: (k) => k.createdBy?.name ?? '—', className: 'hidden sm:table-cell' }]),
            { key: 'used', header: 'Last used', cell: (k) => (k.lastUsedAt ? formatDate(k.lastUsedAt, { withTime: true }) : 'Never') },
            { key: 'expires', header: 'Expires', cell: (k) => (k.expiresAt ? formatDate(k.expiresAt) : 'Never') },
            { key: 'state', header: 'Status', cell: (k) => { const [label, tone] = state(k); return <Badge tone={tone}>{label}</Badge>; } },
            { key: 'revoke', header: <span className="sr-only">Actions</span>, cell: (k) => (k.revokedAt ? null : <Button size="sm" variant="ghost" onClick={() => window.confirm(`Revoke “${k.name}”? Requests using it will fail immediately.`) && revoke.mutate(k.id)}>Revoke<span className="sr-only"> {k.name}</span></Button>) },
          ]}
        />
      </CardContent>
      {creating ? <ApiKeyDialog onClose={() => setCreating(false)} onKey={setSecret} /> : null}
      {secret ? <SecretDialog title="Your API key" description="Store it in your secret manager now." value={secret} onClose={() => setSecret(null)} /> : null}
    </Card>
  );
}

export function IntegrationsSettings() {
  const canHooks = useCan('webhooks.manage');
  return (
    <>
      <PageHeader title="Integrations" description="Connect other systems with signed webhooks and scoped API keys. Every change here is audited." />
      <div className="grid gap-6">
        {canHooks ? <Webhooks /> : null}
        <ApiKeys />
      </div>
    </>
  );
}

const AUDIT_FILTERS = [
  ['', 'All actions'], ['auth.', 'Sign-in & security'], ['roles.', 'Roles'], ['organizations.', 'Organization'], ['employees.', 'People'],
  ['leave.', 'Leave'], ['attendance.', 'Attendance'], ['monitoring.', 'Monitoring'], ['invoices.', 'Invoices'], ['finance.', 'Finance'],
  ['documents.', 'HR documents'], ['customfields.', 'Custom fields'], ['webhooks.', 'Webhooks'], ['apikeys.', 'API keys'],
];

export function AuditLogPage() {
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const query = { limit: 50, ...(action ? { action } : {}), ...(from ? { from: new Date(`${from}T00:00:00`).toISOString() } : {}), ...(to ? { to: new Date(`${to}T23:59:59.999`).toISOString() } : {}) };
  const log = useInfiniteQuery({
    queryKey: ['audit', query],
    queryFn: ({ pageParam }) => api.get('/audit-logs', { query: { ...query, ...(pageParam ? { cursor: pageParam } : {}) } }),
    initialPageParam: undefined,
    getNextPageParam: (last) => last.meta.page.nextCursor ?? undefined,
  });
  const rows = log.data?.pages.flatMap((p) => p.data) ?? [];
  return (
    <>
      <PageHeader title="Audit logs" description="Who did what, and when. Entries cannot be changed or deleted; sensitive values are redacted." />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <FormField label="Action">{(a) => <NativeSelect {...a} value={action} onChange={(e) => setAction(e.target.value)}>{AUDIT_FILTERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</NativeSelect>}</FormField>
        <FormField label="From">{(a) => <Input type="date" {...a} value={from} onChange={(e) => setFrom(e.target.value)} />}</FormField>
        <FormField label="To">{(a) => <Input type="date" {...a} value={to} onChange={(e) => setTo(e.target.value)} />}</FormField>
      </div>
      <Card>
        <DataTable
          caption="Audit log entries"
          scrollable
          rows={rows}
          isPending={log.isPending}
          error={log.error}
          onRetry={() => log.refetch()}
          empty={<EmptyState icon={History} title="No entries" description="Try a wider date range or another action." />}
          columns={[
            { key: 'at', header: 'When', cell: (r) => <span className="whitespace-nowrap">{formatDate(r.at, { withTime: true })}</span> },
            { key: 'actor', header: 'Who', cell: (r) => r.actor.name },
            { key: 'action', header: 'Action', cell: (r) => <span className="font-mono text-xs">{r.action}</span> },
            { key: 'target', header: 'Target', cell: (r) => (r.targetType ? <span className="text-xs">{r.targetType}<span className="block font-mono text-muted-foreground">{r.targetId}</span></span> : '—'), className: 'hidden md:table-cell' },
            {
              key: 'diff',
              header: 'Details',
              cell: (r) => (r.diff ? (
                <details className="max-w-md text-xs">
                  <summary className="cursor-pointer">View</summary>
                  <pre className="mt-1 overflow-x-auto rounded bg-muted p-2 whitespace-pre-wrap break-all">{JSON.stringify(r.diff, null, 2)}</pre>
                </details>
              ) : '—'),
            },
            { key: 'ip', header: 'IP', cell: (r) => <span className="font-mono text-xs">{r.ip ?? '—'}</span>, className: 'hidden lg:table-cell' },
          ]}
        />
      </Card>
      {log.hasNextPage ? <div className="mt-4 flex justify-center"><Button variant="outline" disabled={log.isFetchingNextPage} onClick={() => log.fetchNextPage()}>Load more</Button></div> : null}
    </>
  );
}
