import { Suspense } from 'react';
import { AcceptInvitation } from '@/features/auth/account-forms';

export const metadata = { title: 'Accept invitation' };

export default function Page() {
  return (
    <Suspense>
      <AcceptInvitation />
    </Suspense>
  );
}
