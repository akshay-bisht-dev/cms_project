'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, NativeSelect } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { FormField } from '@/components/common/form-field';
import { PageHeader } from '@/components/common/page-header';
import { ErrorState } from '@/components/common/states';
import { useCan } from '@/features/session/session-provider';
import { api } from '@/lib/api';
import { applyServerErrors } from '@/lib/forms';
import { queryKeys } from '@/lib/query-keys';

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function OrganizationForm({ organization, canEdit }) {
  const queryClient = useQueryClient();
  const form = useForm({
    defaultValues: {
      name: organization.name,
      timeZone: organization.timeZone,
      baseCurrency: organization.baseCurrency,
      locale: organization.locale,
      weekStart: String(organization.weekStart),
      brandColor: organization.brandColor ?? '',
    },
  });
  async function onSubmit(values) {
    try {
      const { data } = await api.patch('/organizations/current', {
        ...values,
        weekStart: Number(values.weekStart),
        baseCurrency: values.baseCurrency.toUpperCase(),
        brandColor: values.brandColor || null,
      });
      queryClient.setQueryData(queryKeys.organization, data);
      queryClient.invalidateQueries({ queryKey: ['me'] });
      toast.success('Organization updated');
      form.reset(form.getValues());
    } catch (error) {
      if (!applyServerErrors(form, error)) toast.error(error.message);
    }
  }
  const e = form.formState.errors;
  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
      <fieldset disabled={!canEdit} className="grid gap-4 sm:grid-cols-2">
        <FormField label="Organization name" error={e.name?.message}>
          {(aria) => <Input {...aria} {...form.register('name')} />}
        </FormField>
        <FormField label="URL slug" hint="Set at registration; cannot be changed.">
          {(aria) => <Input {...aria} value={organization.slug} readOnly disabled />}
        </FormField>
        <FormField label="Time zone" hint="Used for schedules and reports, e.g. Asia/Kolkata." error={e.timeZone?.message}>
          {(aria) => <Input {...aria} {...form.register('timeZone')} />}
        </FormField>
        <FormField label="Base currency" error={e.baseCurrency?.message}>
          {(aria) => <Input maxLength={3} {...aria} {...form.register('baseCurrency')} />}
        </FormField>
        <FormField label="Locale" error={e.locale?.message}>
          {(aria) => <Input {...aria} {...form.register('locale')} />}
        </FormField>
        <FormField label="Week starts on" error={e.weekStart?.message}>
          {(aria) => (
            <NativeSelect {...aria} {...form.register('weekStart')}>
              {WEEKDAYS.map((day, i) => (
                <option key={day} value={i + 1}>
                  {day}
                </option>
              ))}
            </NativeSelect>
          )}
        </FormField>
        <FormField label="Brand color" hint="Hex, e.g. #6D4AE0" error={e.brandColor?.message}>
          {(aria) => <Input {...aria} {...form.register('brandColor')} />}
        </FormField>
      </fieldset>
      {canEdit && (
        <Button type="submit" className="mt-6" disabled={form.formState.isSubmitting || !form.formState.isDirty}>
          Save changes
        </Button>
      )}
    </form>
  );
}

export function OrganizationSettings() {
  const canEdit = useCan('org.settings.manage');
  const organization = useQuery({ queryKey: queryKeys.organization, queryFn: async () => (await api.get('/organizations/current')).data });
  return (
    <>
      <PageHeader title="Organization" description={canEdit ? 'Profile and regional settings.' : 'Only owners can change these settings.'} />
      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>{organization.data ? `${organization.data.memberCount} members (active and invited)` : ' '}</CardDescription>
        </CardHeader>
        <CardContent>
          {organization.isPending ? (
            <Skeleton className="h-64" />
          ) : organization.error ? (
            <ErrorState error={organization.error} onRetry={() => organization.refetch()} />
          ) : (
            <OrganizationForm organization={organization.data} canEdit={canEdit} />
          )}
        </CardContent>
      </Card>
    </>
  );
}
