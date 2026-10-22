import { Suspense } from 'react';
import { LoginFlow } from '@/features/auth/login-flow';

export const metadata = { title: 'Sign in' };

export default function LoginPage() {
  return (
    <Suspense>
      <LoginFlow />
    </Suspense>
  );
}
