import { Suspense } from 'react';
import { TimesheetsPage } from '@/features/timesheets/timesheets-page';

export const metadata = { title: 'Timesheets' };

export default function Page() {
  return (
    <Suspense>
      <TimesheetsPage />
    </Suspense>
  );
}
