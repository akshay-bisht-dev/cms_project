import { Suspense } from 'react';
import { ScreenshotsPage } from '@/features/monitoring/screenshot-timeline';

export const metadata = { title: 'Screenshots' };

export default function Page() {
  return (
    <Suspense>
      <ScreenshotsPage />
    </Suspense>
  );
}
