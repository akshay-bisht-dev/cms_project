import { Suspense } from 'react';
import { IntegrationsSettings } from '@/features/integrations/integrations';

export const metadata = { title: 'Integrations' };

export default function Page() {
  return (
    <Suspense>
      <IntegrationsSettings />
    </Suspense>
  );
}
