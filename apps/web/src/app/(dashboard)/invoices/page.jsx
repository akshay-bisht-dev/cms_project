import { Suspense } from 'react';
import { InvoicesPage } from '@/features/finance/invoices-pages';

export const metadata = { title: 'Invoices' };

export default function Page() {
  return (
    <Suspense>
      <InvoicesPage />
    </Suspense>
  );
}
