import { Suspense } from 'react';
import { ProjectsPage } from '@/features/projects/projects-page';

export const metadata = { title: 'Projects' };

export default function Page() {
  return (
    <Suspense>
      <ProjectsPage />
    </Suspense>
  );
}
