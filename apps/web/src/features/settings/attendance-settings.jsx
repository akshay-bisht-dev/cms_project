'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { CalendarPlus, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input, NativeSelect } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FormField } from '@/components/common/form-field';
import { PageHeader } from '@/components/common/page-header';
import { ErrorState } from '@/components/common/states';
import { useDepartments, useEmployees, useTeams } from '@/features/employees/queries';
import { useCan, useMe } from '@/features/session/session-provider';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { queryKeys } from '@/lib/query-keys';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function describeDays(days) {
  if (!days.length) return 'No working days';
  return days
    .slice()
    .sort((a, b) => a.weekday - b.weekday)
    .map((d) => `${WEEKDAYS[d.weekday - 1]} ${d.start}–${d.end}`)
    .join(', ');
}

function ScheduleDialog({ schedule, onClose }) {
  const queryClient = useQueryClient();
  const initial = Object.fromEntries(
    WEEKDAYS.map((_, i) => {
      const day = schedule?.days.find((d) => d.weekday === i + 1);
      return [i + 1, { on: Boolean(day) || (!schedule && i < 5), start: day?.start ?? '09:00', end: day?.end ?? '18:00' }];
    }),
  );
  const form = useForm({
    defaultValues: { name: schedule?.name ?? '', timeZone: schedule?.timeZone ?? '', isDefault: schedule?.isDefault ?? false, days: initial },
  });
  async function onSubmit(values) {
    const body = {
      name: values.name,
      timeZone: values.timeZone || null,
      isDefault: values.isDefault,
      days: Object.entries(values.days)
        .filter(([, d]) => d.on)
        .map(([weekday, d]) => ({ weekday: Number(weekday), start: d.start, end: d.end })),
    };
    try {
      if (schedule) await api.put(`/attendance/schedules/${schedule.id}`, body);
      else await api.post('/attendance/schedules', body);
      toast.success('Schedule saved');
      queryClient.invalidateQueries({ queryKey: queryKeys.schedules });
      onClose();
    } catch (error) {
      toast.error(error.details?.[0]?.message ?? error.message);
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{schedule ? `Edit ${schedule.name}` : 'New schedule'}</DialogTitle>
          <DialogDescription>Local times. An end at or before the start means the shift ends the next day.</DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Name" required>
              {(aria) => <Input required {...aria} {...form.register('name', { required: true })} />}
            </FormField>
            <FormField label="Time zone" hint="Leave empty to use each person’s zone">
              {(aria) => <Input placeholder="e.g. Asia/Kolkata" {...aria} {...form.register('timeZone')} />}
            </FormField>
          </div>
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">Working hours</legend>
            {WEEKDAYS.map((label, i) => (
              <div key={label} className="grid grid-cols-[5rem_1fr_1fr] items-center gap-2">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" className="size-4 accent-[var(--primary)]" {...form.register(`days.${i + 1}.on`)} />
                  {label}
                </label>
                <Input type="time" aria-label={`${label} start`} {...form.register(`days.${i + 1}.start`)} />
                <Input type="time" aria-label={`${label} end`} {...form.register(`days.${i + 1}.end`)} />
              </div>
            ))}
          </fieldset>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-[var(--primary)]" {...form.register('isDefault')} />
            Default for everyone without a more specific schedule
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={form.formState.isSubmitting}>
              Save schedule
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AssignDialog({ schedule, onClose }) {
  const queryClient = useQueryClient();
  const departments = useDepartments();
  const teams = useTeams();
  const people = useEmployees({ status: 'ACTIVE', limit: 100, sort: 'name' });
  const [targetType, setTargetType] = useState('DEPARTMENT');
  const [targetId, setTargetId] = useState('');
  const options =
    targetType === 'DEPARTMENT'
      ? (departments.data ?? []).map((d) => [d.id, d.name])
      : targetType === 'TEAM'
        ? (teams.data ?? []).map((t) => [t.id, t.name])
        : (people.data?.data ?? []).map((p) => [p.employeeId, p.name]);
  const assign = useMutation({
    mutationFn: () => api.post(`/attendance/schedules/${schedule.id}/assignments`, { targetType, targetId }),
    onSuccess: () => {
      toast.success('Schedule assigned');
      queryClient.invalidateQueries({ queryKey: queryKeys.schedules });
      onClose();
    },
    onError: (error) => toast.error(error.message),
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign {schedule.name}</DialogTitle>
          <DialogDescription>A person’s own schedule wins over their team’s, which wins over their department’s.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Assign to">
            {(aria) => (
              <NativeSelect {...aria} value={targetType} onChange={(e) => (setTargetType(e.target.value), setTargetId(''))}>
                <option value="DEPARTMENT">Department</option>
                <option value="TEAM">Team</option>
                <option value="MEMBER">Employee</option>
              </NativeSelect>
            )}
          </FormField>
          <FormField label="Which">
            {(aria) => (
              <NativeSelect {...aria} value={targetId} onChange={(e) => setTargetId(e.target.value)}>
                <option value="">Choose…</option>
                {options.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </NativeSelect>
            )}
          </FormField>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!targetId || assign.isPending} onClick={() => assign.mutate()}>
            Assign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Schedules({ canEdit }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(null);
  const [assigning, setAssigning] = useState(null);
  const schedules = useQuery({ queryKey: queryKeys.schedules, queryFn: async () => (await api.get('/attendance/schedules')).data });
  const archive = useMutation({
    mutationFn: (id) => api.delete(`/attendance/schedules/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.schedules }),
    onError: (error) => toast.error(error.message),
  });
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-2">
        <div>
          <CardTitle>Work schedules</CardTitle>
          <CardDescription>Used to detect late arrivals, early departures, overtime and absences.</CardDescription>
        </div>
        {canEdit && (
          <Button size="sm" onClick={() => setEditing('new')}>
            <Plus aria-hidden /> New schedule
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {schedules.isPending ? (
          <Skeleton className="h-20" />
        ) : schedules.error ? (
          <ErrorState error={schedules.error} onRetry={() => schedules.refetch()} />
        ) : schedules.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">No schedules yet. Without one, lateness and absences are not tracked.</p>
        ) : (
          <ul className="divide-y">
            {schedules.data.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 font-medium">
                    {s.name} {s.isDefault && <Badge tone="info">Default</Badge>}
                  </p>
                  <p className="text-muted-foreground">{describeDays(s.days)}</p>
                  <p className="text-xs text-muted-foreground">
                    {s.timeZone ?? 'Each person’s time zone'} · {s.assignments.length} assignment{s.assignments.length === 1 ? '' : 's'}
                  </p>
                </div>
                {canEdit && (
                  <span className="flex gap-1">
                    <Button variant="outline" size="sm" onClick={() => setAssigning(s)}>
                      Assign
                    </Button>
                    <Button variant="ghost" size="icon" aria-label={`Edit ${s.name}`} onClick={() => setEditing(s)}>
                      <Pencil aria-hidden />
                    </Button>
                    <Button variant="ghost" size="icon" aria-label={`Archive ${s.name}`} onClick={() => archive.mutate(s.id)}>
                      <Trash2 aria-hidden />
                    </Button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      {editing && <ScheduleDialog schedule={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {assigning && <AssignDialog schedule={assigning} onClose={() => setAssigning(null)} />}
    </Card>
  );
}

function Holidays({ canEdit }) {
  const queryClient = useQueryClient();
  const [year, setYear] = useState(new Date().getUTCFullYear());
  const holidays = useQuery({ queryKey: queryKeys.holidays(year), queryFn: async () => (await api.get('/attendance/holidays', { query: { year } })).data });
  const form = useForm({ defaultValues: { date: '', name: '' } });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['attendance', 'holidays'] });
  const remove = useMutation({ mutationFn: (id) => api.delete(`/attendance/holidays/${id}`), onSuccess: refresh, onError: (e) => toast.error(e.message) });
  async function add(values) {
    try {
      await api.post('/attendance/holidays', { ...values, isHalfDay: false });
      form.reset();
      refresh();
    } catch (error) {
      toast.error(error.code === 'CONFLICT' ? 'There is already a holiday on that date' : error.message);
    }
  }
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-2">
        <div>
          <CardTitle>Holidays</CardTitle>
          <CardDescription>No one is marked absent on a holiday.</CardDescription>
        </div>
        <NativeSelect aria-label="Year" className="w-28" value={year} onChange={(e) => setYear(Number(e.target.value))}>
          {[year - 1, year, year + 1].map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </NativeSelect>
      </CardHeader>
      <CardContent>
        {canEdit && (
          <form onSubmit={form.handleSubmit(add)} className="mb-4 grid gap-2 sm:grid-cols-[10rem_1fr_auto]">
            <Input type="date" aria-label="Holiday date" required {...form.register('date', { required: true })} />
            <Input aria-label="Holiday name" placeholder="Name" required maxLength={120} {...form.register('name', { required: true })} />
            <Button type="submit" variant="outline">
              <CalendarPlus aria-hidden /> Add
            </Button>
          </form>
        )}
        {holidays.isPending ? (
          <Skeleton className="h-16" />
        ) : holidays.data?.length ? (
          <ul className="divide-y">
            {holidays.data.map((h) => (
              <li key={h.id} className="flex items-center gap-3 py-2 text-sm">
                <span className="w-32 text-muted-foreground">{formatDate(h.date)}</span>
                <span className="flex-1">{h.name}</span>
                {canEdit && (
                  <Button variant="ghost" size="icon" aria-label={`Remove ${h.name}`} onClick={() => remove.mutate(h.id)}>
                    <Trash2 aria-hidden />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No holidays in {year}.</p>
        )}
      </CardContent>
    </Card>
  );
}

function Rules({ canEdit }) {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ['organization', 'settings'], queryFn: async () => (await api.get('/organizations/current/settings')).data });
  if (settings.isPending) return <Skeleton className="h-48" />;
  if (settings.error) return <ErrorState error={settings.error} onRetry={() => settings.refetch()} />;
  return <RulesForm settings={settings.data} canEdit={canEdit} onSaved={() => queryClient.invalidateQueries({ queryKey: ['organization'] })} />;
}

function RulesForm({ settings, canEdit, onSaved }) {
  const form = useForm({ defaultValues: { attendance: settings.attendance, timeTracking: settings.timeTracking } });
  async function onSubmit(values) {
    const num = (v) => Number(v);
    try {
      await api.put('/organizations/current/settings/attendance', {
        ...settings.attendance,
        graceLateMinutes: num(values.attendance.graceLateMinutes),
        graceEarlyMinutes: num(values.attendance.graceEarlyMinutes),
        missedClockOutGraceHours: num(values.attendance.missedClockOutGraceHours),
        maxSessionHours: num(values.attendance.maxSessionHours),
      });
      await api.put('/organizations/current/settings/timeTracking', values.timeTracking);
      toast.success('Rules saved. They apply from now on.');
      onSaved();
    } catch (error) {
      toast.error(error.details?.[0]?.message ?? error.message);
    }
  }
  const number = (name, label, hint) => (
    <FormField label={label} hint={hint}>
      {(aria) => <Input type="number" min={0} {...aria} {...form.register(name)} />}
    </FormField>
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>Rules</CardTitle>
        <CardDescription>How lateness, forgotten clock-outs and timesheets work.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={form.handleSubmit(onSubmit)}>
          <fieldset disabled={!canEdit} className="grid gap-4 sm:grid-cols-2">
            {number('attendance.graceLateMinutes', 'Late after (minutes)', 'Grace period after the scheduled start')}
            {number('attendance.graceEarlyMinutes', 'Early leave before (minutes)', 'Grace period before the scheduled end')}
            {number('attendance.missedClockOutGraceHours', 'Close forgotten sessions after (hours)', 'Hours past the scheduled end')}
            {number('attendance.maxSessionHours', 'Maximum session length (hours)', 'Sessions are closed after this long')}
            <FormField label="Timesheet period">
              {(aria) => (
                <NativeSelect {...aria} {...form.register('timeTracking.timesheetPeriod')}>
                  <option value="DAILY">Daily</option>
                  <option value="WEEKLY">Weekly</option>
                  <option value="BIWEEKLY">Every two weeks</option>
                  <option value="SEMIMONTHLY">Twice a month</option>
                </NativeSelect>
              )}
            </FormField>
            <div className="grid content-start gap-2 text-sm">
              <label className="flex items-center gap-2">
                <input type="checkbox" className="size-4 accent-[var(--primary)]" {...form.register('timeTracking.autoClockInOnTimerStart')} />
                Starting the timer clocks people in
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" className="size-4 accent-[var(--primary)]" {...form.register('timeTracking.allowManualEntries')} />
                Allow manual time entries
              </label>
            </div>
          </fieldset>
          {canEdit && (
            <Button type="submit" className="mt-6" disabled={form.formState.isSubmitting}>
              Save rules
            </Button>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

export function AttendanceSettings() {
  const canEdit = useCan('org.settings.manage');
  const me = useMe();
  return (
    <>
      <PageHeader title="Attendance & time" description={`Schedules, holidays and rules for ${me.organization.name}.`} />
      <div className="grid gap-4">
        <Schedules canEdit={canEdit} />
        <div className="grid gap-4 lg:grid-cols-2">
          <Holidays canEdit={canEdit} />
          <Rules canEdit={canEdit} />
        </div>
      </div>
    </>
  );
}
