import { Suspense } from 'react';
import { ExpensesPage } from '@/features/finance/expenses-pages';

export const metadata = { title: 'Expenses' };

export default function Page() {
  return (
    <Suspense>
      <ExpensesPage />
    </Suspense>
  );
}
