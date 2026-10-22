import { Suspense } from 'react';
import { EmployeeDirectory } from '@/features/employees/directory';

export const metadata = { title: 'People' };

export default function EmployeesPage() {
  return (
    <Suspense>
      <EmployeeDirectory />
    </Suspense>
  );
}
