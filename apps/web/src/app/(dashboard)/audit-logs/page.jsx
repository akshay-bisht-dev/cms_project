import { Suspense } from 'react';
import { AuditLogPage } from '@/features/integrations/integrations';

export const metadata = { title: 'Audit logs' };

export default function Page() {
  return (
    <Suspense>
      <AuditLogPage />
    </Suspense>
  );
}
