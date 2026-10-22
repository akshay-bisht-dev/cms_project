import { notFound } from 'next/navigation';
import { ProjectDetail } from '@/features/projects/project-detail';
import { PROJECT_TABS } from '@/features/projects/tabs';

export const metadata = { title: 'Project' };

export default async function Page({ params }) {
  const { projectId, tab = ['board'] } = await params;
  if (tab.length !== 1 || !PROJECT_TABS.some((t) => t.id === tab[0])) notFound();
  return <ProjectDetail projectId={projectId} tab={tab[0]} />;
}
