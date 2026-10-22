import { Suspense } from 'react';
import { FinanceSettings } from '@/features/finance/expenses-pages';

export const metadata = { title: 'Finance settings' };

export default function Page() {
  return (
    <Suspense>
      <FinanceSettings />
    </Suspense>
  );
}
