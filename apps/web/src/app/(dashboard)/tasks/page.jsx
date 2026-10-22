import { Suspense } from 'react';
import { MyTasks } from '@/features/tasks/my-tasks';

export const metadata = { title: 'My tasks' };

export default function Page() {
  return (
    <Suspense>
      <MyTasks />
    </Suspense>
  );
}
