import { Suspense } from 'react';
import { RegisterForm } from '@/features/auth/account-forms';

export const metadata = { title: 'Create organization' };

export default function Page() {
  return (
    <Suspense>
      <RegisterForm />
    </Suspense>
  );
}
