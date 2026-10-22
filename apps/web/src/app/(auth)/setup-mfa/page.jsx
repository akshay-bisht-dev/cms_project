'use client';

import { useRouter } from 'next/navigation';
import { AuthHeading } from '@/features/auth/auth-card';
import { MfaEnrollment } from '@/features/auth/mfa-enrollment';

export default function SetupMfaPage() {
  const router = useRouter();
  return (
    <>
      <AuthHeading title="Protect your account" description="Your organization requires two-factor authentication before you continue." />
      <MfaEnrollment
        onComplete={() => {
          router.replace('/my-dashboard');
          router.refresh();
        }}
      />
    </>
  );
}
