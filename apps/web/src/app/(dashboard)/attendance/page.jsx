import { Suspense } from 'react';
import { AttendancePage } from '@/features/attendance/attendance-page';

export const metadata = { title: 'Attendance' };

export default function Page() {
  return (
    <Suspense>
      <AttendancePage />
    </Suspense>
  );
}
