import { Suspense } from 'react';
import { ChecklistsPage } from '@/features/hr/hr-pages';

export const metadata = { title: 'Checklists' };

export default function Page() {
  return (
    <Suspense>
      <ChecklistsPage />
    </Suspense>
  );
}
