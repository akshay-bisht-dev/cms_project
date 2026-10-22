import { Suspense } from 'react';
import { ActivityPage } from '@/features/activity/activity-page';

export const metadata = { title: 'Activity' };

export default function Page() {
  return (
    <Suspense>
      <ActivityPage />
    </Suspense>
  );
}
