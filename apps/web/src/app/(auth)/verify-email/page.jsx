import { Suspense } from 'react';
import { VerifyEmail } from '@/features/auth/account-forms';

export const metadata = { title: 'Verify email' };

export default function Page() {
  return (
    <Suspense>
      <VerifyEmail />
    </Suspense>
  );
}
