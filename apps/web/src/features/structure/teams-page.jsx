'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, UsersRound } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, NativeSelect } from '@/components/ui/input';
import { FormField } from '@/components/common/form-field';
import { PageHeader } from '@/components/common/page-header';
import { EmptyState } from '@/components/common/states';
import { DataTable } from '@/components/data-tables/data-table';
import { useCan, useMe } from '@/features/session/session-provider';
import { useDepartments, useEmployees, useInvalidateEmployees, useTeams } from '@/features/employees/queries';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';

function MembersDialog({ team, onClose }) {
  const detail = useQuery({ queryKey: queryKeys.team(team.id), queryFn: async () => (await api.get(`/teams/${team.id}`)).data });
  const people = useEmployees({ status: 'ACTIVE', limit: 100, sort: 'name' });
  const invalidate = useInvalidateEmployees();
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState(null);
  const current = useMemo(() => new Set(detail.data?.members.map((m) => m.employeeId) ?? []), [detail.data]);
  const chosen = selected ?? current;
  const leadId = detail.data?.lead?.employeeId;

  async function save() {
    try {
      await api.put(`/teams/${team.id}/members`, { employeeIds: [...chosen] });
      toast.success('Team members updated');
      await invalidate();
      onClose();
    } catch (error) {
      toast.error(error.message);
    }
  }

  const visible = (people.data?.data ?? []).filter((p) => p.name.toLowerCase().includes(filter.toLowerCase()));
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Members of {team.name}</DialogTitle>
          <DialogDescription>The team lead is always a member.</DialogDescription>
        </DialogHeader>
        <Input aria-label="Filter people" placeholder="Filter people" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <fieldset className="max-h-72 overflow-y-auto rounded-md border">
          <legend className="sr-only">Team members</legend>
          {visible.map((p) => (
            <label key={p.employeeId} className="flex items-center gap-3 border-b px-3 py-2 text-sm last:border-b-0">
              <input
                type="checkbox"
                className="size-4 accent-[var(--primary)]"
                disabled={p.employeeId === leadId}
                checked={chosen.has(p.employeeId)}
                onChange={(e) => {
                  const next = new Set(chosen);
                  if (e.target.checked) next.add(p.employeeId);
                  else next.delete(p.employeeId);
                  setSelected(next);
                }}
              />
              <span className="flex-1">{p.name}</span>
              {p.employeeId === leadId && <span className="text-xs text-muted-foreground">Lead</span>}
            </label>
          ))}
        </fieldset>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={detail.isPending}>
            Save members
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NewTeamDialog({ onClose }) {
  const departments = useDepartments();
  const people = useEmployees({ status: 'ACTIVE', limit: 100, sort: 'name' });
  const invalidate = useInvalidateEmployees();
  const [values, setValues] = useState({ name: '', departmentId: '', leadEmployeeId: '' });
  const [error, setError] = useState(null);
  async function create(event) {
    event.preventDefault();
    try {
      await api.post('/teams', {
        name: values.name,
        departmentId: values.departmentId || null,
        leadEmployeeId: values.leadEmployeeId || null,
      });
      toast.success('Team created');
      await invalidate();
      onClose();
    } catch (err) {
      setError(err.details?.[0]?.message ?? err.message);
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>New team</DialogTitle>
        </DialogHeader>
        <form onSubmit={create} className="grid gap-4">
          <FormField label="Name" required error={error}>
            {(aria) => <Input {...aria} value={values.name} onChange={(e) => setValues({ ...values, name: e.target.value })} required />}
          </FormField>
          <FormField label="Department">
            {(aria) => (
              <NativeSelect {...aria} value={values.departmentId} onChange={(e) => setValues({ ...values, departmentId: e.target.value })}>
                <option value="">None</option>
                {departments.data?.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </NativeSelect>
            )}
          </FormField>
          <FormField label="Team lead">
            {(aria) => (
              <NativeSelect {...aria} value={values.leadEmployeeId} onChange={(e) => setValues({ ...values, leadEmployeeId: e.target.value })}>
                <option value="">No lead</option>
                {people.data?.data.map((p) => (
                  <option key={p.employeeId} value={p.employeeId}>
                    {p.name}
                  </option>
                ))}
              </NativeSelect>
            )}
          </FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">Create team</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function TeamsPage() {
  const me = useMe();
  const teams = useTeams();
  const departments = useDepartments();
  const canManageAll = useCan('teams.manage', 'org');
  const canManageOwn = useCan('teams.manage', 'team');
  const [membersOf, setMembersOf] = useState(null);
  const [creating, setCreating] = useState(false);
  const departmentName = (id) => departments.data?.find((d) => d.id === id)?.name ?? '—';
  const canEditMembers = (team) => canManageAll || (canManageOwn && team.lead?.employeeId === me.employeeId);

  const columns = [
    { key: 'name', header: 'Team', cell: (t) => <span className="font-medium">{t.name}</span> },
    { key: 'department', header: 'Department', cell: (t) => departmentName(t.departmentId), className: 'hidden md:table-cell' },
    { key: 'lead', header: 'Lead', cell: (t) => t.lead?.name ?? '—' },
    { key: 'members', header: 'Members', cell: (t) => <span className="tabular-nums">{t.memberCount}</span> },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      className: 'text-right',
      cell: (t) =>
        canEditMembers(t) ? (
          <Button variant="ghost" size="sm" onClick={() => setMembersOf(t)}>
            Manage members
          </Button>
        ) : null,
    },
  ];

  return (
    <>
      <PageHeader
        title="Teams"
        description="Team leads can review and approve work for their team members."
        actions={
          canManageAll && (
            <Button onClick={() => setCreating(true)}>
              <Plus aria-hidden /> New team
            </Button>
          )
        }
      />
      <Card>
        <DataTable
          caption="Teams"
          columns={columns}
          rows={teams.data ?? []}
          isPending={teams.isPending}
          error={teams.error}
          onRetry={() => teams.refetch()}
          empty={<EmptyState icon={UsersRound} title="No teams yet" />}
        />
      </Card>
      {membersOf && <MembersDialog team={membersOf} onClose={() => setMembersOf(null)} />}
      {creating && <NewTeamDialog onClose={() => setCreating(false)} />}
    </>
  );
}
