import { Suspense } from 'react';
import { LeaveSettings } from '@/features/leave/leave-settings';

export const metadata = { title: 'Leave settings' };

export default function Page() {
  return (
    <Suspense>
      <LeaveSettings />
    </Suspense>
  );
}
