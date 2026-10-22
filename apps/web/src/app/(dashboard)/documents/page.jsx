import { Suspense } from 'react';
import { DocumentsPage } from '@/features/hr/hr-pages';

export const metadata = { title: 'Documents' };

export default function Page() {
  return (
    <Suspense>
      <DocumentsPage />
    </Suspense>
  );
}
