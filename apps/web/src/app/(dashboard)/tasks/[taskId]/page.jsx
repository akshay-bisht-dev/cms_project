import { TaskDetail } from '@/features/tasks/task-detail';

export const metadata = { title: 'Task' };

export default async function Page({ params }) {
  const { taskId } = await params;
  return <TaskDetail taskId={taskId} />;
}
