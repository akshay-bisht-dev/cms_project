'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/input';
import { FormField } from '@/components/common/form-field';
import { api } from '@/lib/api';
import { applyServerErrors } from '@/lib/forms';
import { formatTime } from '@/lib/format';
import { isoToZonedInput, zonedInputToIso } from '@/lib/zoned-time';


/** kind: ADD (missing time), MODIFY or DELETE (an existing session). */
export function CorrectionDialog({ kind, session, defaultDate, timeZone, onClose }) {
  const queryClient = useQueryClient();
  const [key] = useState(() => crypto.randomUUID());
  const form = useForm({
    defaultValues: {
      start: session ? isoToZonedInput(session.startedAt, timeZone).local : `${defaultDate}T09:00`,
      end: session?.endedAt ? isoToZonedInput(session.endedAt, timeZone).local : `${defaultDate}T17:00`,
      reason: '',
    },
  });
  const titles = { ADD: 'Add missing time', MODIFY: 'Fix session times', DELETE: 'Remove a session' };

  async function onSubmit({ start, end, reason }) {
    const body = { kind, reason, ...(session ? { workSessionId: session.id } : {}) };
    if (kind !== 'DELETE') Object.assign(body, { proposedStartAt: zonedInputToIso(start, timeZone), proposedEndAt: zonedInputToIso(end, timeZone) });
    try {
      await api.post('/attendance/corrections', body, { idempotencyKey: key });
      toast.success('Correction requested. Your approver has been notified.');
      queryClient.invalidateQueries({ queryKey: ['attendance'] });
      onClose();
    } catch (error) {
      const mapped = { ...error, details: (error.details ?? []).map((d) => ({ ...d, path: d.path.replace('proposedStartAt', 'start').replace('proposedEndAt', 'end') })) };
      if (!applyServerErrors(form, mapped)) toast.error(error.message);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{titles[kind]}</DialogTitle>
          <DialogDescription>
            {session ? `Session ${formatTime(session.startedAt, timeZone)} – ${formatTime(session.endedAt, timeZone)}. ` : ''}
            Changes apply after approval. Times are in {timeZone}.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-4">
          {kind !== 'DELETE' && (
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Start" required error={form.formState.errors.start?.message}>
                {(aria) => <Input type="datetime-local" required {...aria} {...form.register('start', { required: true })} />}
              </FormField>
              <FormField label="End" required error={form.formState.errors.end?.message}>
                {(aria) => <Input type="datetime-local" required {...aria} {...form.register('end', { required: true })} />}
              </FormField>
            </div>
          )}
          <FormField label="Reason" required error={form.formState.errors.reason?.message}>
            {(aria) => <Textarea maxLength={500} {...aria} {...form.register('reason', { required: 'Explain what happened', minLength: { value: 3, message: 'Explain what happened' } })} />}
          </FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={form.formState.isSubmitting}>
              Request correction
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
