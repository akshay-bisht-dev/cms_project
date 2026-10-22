import { Suspense } from 'react';
import { PipelinePage } from '@/features/crm/sales-pages';

export const metadata = { title: 'Pipeline' };

export default function Page() {
  return (
    <Suspense>
      <PipelinePage />
    </Suspense>
  );
}
