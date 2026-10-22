'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input, Textarea } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { FormField } from '@/components/common/form-field';
import { PageHeader } from '@/components/common/page-header';
import { ErrorState } from '@/components/common/states';
import { useEmployees } from '@/features/employees/queries';
import { projectKeys, useInvalidateWork } from '@/features/projects/queries';
import { useMe } from '@/features/session/session-provider';
import { api } from '@/lib/api';
import { todayIn } from '@/lib/format';
import { zonedInputToIso } from '@/lib/zoned-time';
import { MonthGrid, monthWeeks } from './month-grid';

const SOURCES = [
  { id: 'meetings', label: 'Meetings' },
  { id: 'tasks', label: 'My task deadlines' },
  { id: 'milestones', label: 'Milestones' },
  { id: 'holidays', label: 'Holidays' },
];

function MeetingDialog({ date, zone, onClose }) {
  const invalidate = useInvalidateWork();
  const people = useEmployees({ status: 'ACTIVE', limit: 100, sort: 'name' });
  const [attendees, setAttendees] = useState(new Set());
  const form = useForm({ defaultValues: { title: '', date, start: '10:00', end: '10:30', location: '', description: '' } });
  async function onSubmit(v) {
    try {
      await api.post('/calendar/events', {
        title: v.title,
        startAt: zonedInputToIso(`${v.date}T${v.start}`, zone),
        endAt: zonedInputToIso(`${v.date}T${v.end}`, zone),
        location: v.location || undefined,
        description: v.description || undefined,
        attendeeEmployeeIds: [...attendees],
      });
      toast.success('Meeting scheduled. Attendees were notified.');
      invalidate();
      onClose();
    } catch (error) {
      toast.error(error.details?.[0]?.message ?? error.message);
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Schedule a meeting</DialogTitle>
          <DialogDescription>Times are in {zone}.</DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-4">
          <FormField label="Title" required>
            {(aria) => <Input required maxLength={200} {...aria} {...form.register('title', { required: true })} />}
          </FormField>
          <div className="grid gap-4 sm:grid-cols-3">
            <FormField label="Date">{(aria) => <Input type="date" required {...aria} {...form.register('date')} />}</FormField>
            <FormField label="Start">{(aria) => <Input type="time" required {...aria} {...form.register('start')} />}</FormField>
            <FormField label="End">{(aria) => <Input type="time" required {...aria} {...form.register('end')} />}</FormField>
          </div>
          <FormField label="Location or link">{(aria) => <Input maxLength={200} {...aria} {...form.register('location')} />}</FormField>
          <FormField label="Notes">{(aria) => <Textarea maxLength={5000} {...aria} {...form.register('description')} />}</FormField>
          <fieldset>
            <legend className="mb-1 text-sm font-medium">Attendees</legend>
            <ul className="max-h-40 overflow-y-auto rounded-md border">
              {people.data?.data.map((p) => (
                <li key={p.employeeId}>
                  <label className="flex items-center gap-2 px-3 py-1.5 text-sm">
                    <input
                      type="checkbox"
                      className="size-4 accent-[var(--primary)]"
                      checked={attendees.has(p.employeeId)}
                      onChange={(e) =>
                        setAttendees((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(p.employeeId);
                          else next.delete(p.employeeId);
                          return next;
                        })
                      }
                    />
                    {p.name}
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={form.formState.isSubmitting}>
              Schedule
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function CalendarPage() {
  const me = useMe();
  const zone = me.organization.timeZone;
  const today = todayIn(zone);
  const [month, setMonth] = useState(today.slice(0, 7));
  const [enabled, setEnabled] = useState(new Set(SOURCES.map((s) => s.id)));
  const [newOn, setNewOn] = useState(null);
  const weeks = monthWeeks(month);
  const params = { from: weeks[0][0], to: weeks.at(-1)[6], sources: SOURCES.map((s) => s.id).join(',') };
  const calendar = useQuery({ queryKey: projectKeys.calendar(params), queryFn: async () => (await api.get('/calendar', { query: params })).data });
  const shift = (delta) => {
    const d = new Date(`${month}-01T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + delta);
    setMonth(d.toISOString().slice(0, 7));
  };
  const items = (calendar.data ?? []).filter((i) => enabled.has(i.source));

  return (
    <>
      <PageHeader
        title="Calendar"
        description="Your meetings and deadlines, milestones of projects you can see, and holidays."
        actions={
          <Button onClick={() => setNewOn(today)}>
            <Plus aria-hidden /> New meeting
          </Button>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Button variant="outline" size="icon" aria-label="Previous month" onClick={() => shift(-1)}>
          <ChevronLeft aria-hidden />
        </Button>
        <span className="min-w-40 text-center text-sm font-medium">
          {new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-01T00:00:00Z`))}
        </span>
        <Button variant="outline" size="icon" aria-label="Next month" onClick={() => shift(1)}>
          <ChevronRight aria-hidden />
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setMonth(today.slice(0, 7))}>
          Today
        </Button>
        <fieldset className="ml-auto flex flex-wrap gap-3">
          <legend className="sr-only">Show</legend>
          {SOURCES.map((s) => (
            <label key={s.id} className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-[var(--primary)]"
                checked={enabled.has(s.id)}
                onChange={(e) =>
                  setEnabled((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(s.id);
                    else next.delete(s.id);
                    return next;
                  })
                }
              />
              {s.label}
            </label>
          ))}
        </fieldset>
      </div>
      <Card>
        <CardContent className="pt-5">
          {calendar.isPending ? <Skeleton className="h-96" /> : calendar.error ? <ErrorState error={calendar.error} onRetry={() => calendar.refetch()} /> : <MonthGrid month={month} items={items} today={today} onDayClick={setNewOn} />}
        </CardContent>
      </Card>
      {newOn && <MeetingDialog date={newOn} zone={zone} onClose={() => setNewOn(null)} />}
    </>
  );
}
