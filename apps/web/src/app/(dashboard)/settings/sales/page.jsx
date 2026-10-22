import { Suspense } from 'react';
import { SalesSettings } from '@/features/crm/sales-settings';

export const metadata = { title: 'Sales & support settings' };

export default function Page() {
  return (
    <Suspense>
      <SalesSettings />
    </Suspense>
  );
}
