import { Suspense } from 'react';
import { LeavePage } from '@/features/leave/leave-page';

export const metadata = { title: 'Time off' };

export default function Page() {
  return (
    <Suspense>
      <LeavePage />
    </Suspense>
  );
}
