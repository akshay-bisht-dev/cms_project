import { Suspense } from 'react';
import { TicketsPage } from '@/features/tickets/tickets-pages';

export const metadata = { title: 'Support tickets' };

export default function Page() {
  return (
    <Suspense>
      <TicketsPage />
    </Suspense>
  );
}
