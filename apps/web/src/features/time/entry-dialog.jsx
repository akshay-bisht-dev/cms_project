'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { FormField } from '@/components/common/form-field';
import { api } from '@/lib/api';
import { applyServerErrors } from '@/lib/forms';
import { isoToZonedInput, zonedInputToIso } from '@/lib/zoned-time';
import { WorkPicker } from '@/features/projects/work-picker';


/** Add or edit a time entry. Times are entered in the member's zone and sent as UTC instants. */
export function EntryDialog({ entry, defaultDate, timeZone, employeeId, onClose }) {
  const queryClient = useQueryClient();
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [work, setWork] = useState({ projectId: entry?.project?.id ?? null, taskId: entry?.task?.id ?? null });
  const start = entry ? isoToZonedInput(entry.startedAt, timeZone) : { date: defaultDate, time: '09:00' };
  const end = entry ? isoToZonedInput(entry.endedAt, timeZone) : { date: defaultDate, time: '10:00' };
  const form = useForm({
    defaultValues: { date: start.date, start: start.time, end: end.time, description: entry?.description ?? '', isBillable: entry?.isBillable ?? false, reason: '' },
  });

  async function onSubmit(values) {
    const startedAt = zonedInputToIso(`${values.date}T${values.start}`, timeZone);
    let endedAt = zonedInputToIso(`${values.date}T${values.end}`, timeZone);
    if (endedAt <= startedAt) endedAt = new Date(Date.parse(endedAt) + 86_400_000).toISOString(); // ends after midnight
    const body = { startedAt, endedAt, description: values.description || undefined, isBillable: values.isBillable, reason: values.reason || undefined, projectId: work.projectId ?? undefined, taskId: work.taskId ?? undefined };
    try {
      if (entry) await api.patch(`/time-entries/${entry.id}`, { ...body, description: values.description || null, projectId: work.projectId, taskId: work.taskId, version: entry.version });
      else await api.post('/time-entries', { ...body, ...(employeeId ? { employeeId } : {}) }, { idempotencyKey });
      toast.success(entry ? 'Entry updated' : 'Entry added');
      queryClient.invalidateQueries({ queryKey: ['time-entries'] });
      queryClient.invalidateQueries({ queryKey: ['timesheets'] });
      onClose();
    } catch (error) {
      if (!applyServerErrors(form, error)) toast.error(error.message);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{entry ? 'Edit time entry' : 'Add time manually'}</DialogTitle>
          <DialogDescription>Times are in {timeZone}. Every change is kept in the entry’s history.</DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <FormField label="Date" required>
              {(aria) => <Input type="date" required {...aria} {...form.register('date', { required: true })} />}
            </FormField>
            <FormField label="Start" required error={form.formState.errors.startedAt?.message}>
              {(aria) => <Input type="time" required {...aria} {...form.register('start', { required: true })} />}
            </FormField>
            <FormField label="End" required error={form.formState.errors.endedAt?.message}>
              {(aria) => <Input type="time" required {...aria} {...form.register('end', { required: true })} />}
            </FormField>
          </div>
          {!employeeId && (
            <fieldset>
              <legend className="mb-1.5 text-sm font-medium">Project and task</legend>
              <WorkPicker projectId={work.projectId} taskId={work.taskId} onChange={setWork} idPrefix="entry" />
            </fieldset>
          )}
          <FormField label="Description">{(aria) => <Input maxLength={500} {...aria} {...form.register('description')} />}</FormField>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-[var(--primary)]" {...form.register('isBillable')} />
            Billable
          </label>
          {entry && <FormField label="Reason for the change">{(aria) => <Input maxLength={500} {...aria} {...form.register('reason')} />}</FormField>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={form.formState.isSubmitting}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
