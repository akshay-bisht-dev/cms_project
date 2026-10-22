import { Suspense } from 'react';
import { LeadsPage } from '@/features/crm/sales-pages';

export const metadata = { title: 'Leads' };

export default function Page() {
  return (
    <Suspense>
      <LeadsPage />
    </Suspense>
  );
}
