import { notFound } from 'next/navigation';
import { EmployeeProfile } from '@/features/employees/profile/employee-profile';
import { AVAILABLE_TABS } from '@/features/employees/profile/tabs';

export const metadata = { title: 'Employee' };

export default async function EmployeePage({ params }) {
  const { employeeId, tab = ['dashboard'] } = await params;
  if (tab.length !== 1 || !AVAILABLE_TABS.has(tab[0])) notFound();
  return <EmployeeProfile employeeId={employeeId} tab={tab[0]} />;
}
