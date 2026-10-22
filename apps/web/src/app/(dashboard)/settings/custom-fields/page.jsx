import { Suspense } from 'react';
import { CustomFieldsSettings } from '@/features/custom-fields/custom-fields';

export const metadata = { title: 'Custom fields' };

export default function Page() {
  return (
    <Suspense>
      <CustomFieldsSettings />
    </Suspense>
  );
}
