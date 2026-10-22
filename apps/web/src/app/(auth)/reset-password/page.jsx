import { Suspense } from 'react';
import { ResetPasswordForm } from '@/features/auth/account-forms';

export const metadata = { title: 'Choose a new password' };

export default function Page() {
  return (
    <Suspense>
      <ResetPasswordForm />
    </Suspense>
  );
}
