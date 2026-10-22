import { Suspense } from 'react';
import { QuotesPage } from '@/features/crm/sales-pages';

export const metadata = { title: 'Quotes' };

export default function Page() {
  return (
    <Suspense>
      <QuotesPage />
    </Suspense>
  );
}
