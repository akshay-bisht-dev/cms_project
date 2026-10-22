import { Suspense } from 'react';
import { ClientsPage } from '@/features/crm/clients-page';

export const metadata = { title: 'Clients' };

export default function Page() {
  return (
    <Suspense>
      <ClientsPage />
    </Suspense>
  );
}
