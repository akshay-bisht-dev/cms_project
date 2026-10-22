import { Suspense } from 'react';
import { ForgotPasswordForm } from '@/features/auth/account-forms';

export const metadata = { title: 'Reset password' };

export default function Page() {
  return (
    <Suspense>
      <ForgotPasswordForm />
    </Suspense>
  );
}
