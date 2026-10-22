import { Suspense } from 'react';
import { OrgDashboard } from '@/features/dashboard/org-dashboard';

export const metadata = { title: 'Dashboard' };

export default function DashboardPage() {
  return (
    <Suspense>
      <OrgDashboard />
    </Suspense>
  );
}
