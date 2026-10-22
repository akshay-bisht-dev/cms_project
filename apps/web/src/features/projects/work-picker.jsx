'use client';

import { NativeSelect } from '@/components/ui/input';
import { useProjects, useTasks } from './queries';

/**
 * Project → task selects for time tracking. Lists only projects the person belongs to and their
 * open tasks; the API re-checks membership.
 */
export function WorkPicker({ projectId, taskId, onChange, idPrefix = 'work' }) {
  const projects = useProjects({ mine: 'true', status: 'PLANNED,ACTIVE,ON_HOLD' });
  const tasks = useTasks({ projectId, statusCategory: 'TODO,IN_PROGRESS', sort: 'dueDate' }, { enabled: Boolean(projectId) });
  return (
    <div className="grid gap-2">
      <NativeSelect id={`${idPrefix}-project`} aria-label="Project" value={projectId ?? ''} onChange={(e) => onChange({ projectId: e.target.value || null, taskId: null })}>
        <option value="">No project</option>
        {projects.data?.map((p) => (
          <option key={p.id} value={p.id}>
            {p.code} · {p.name}
          </option>
        ))}
      </NativeSelect>
      {projectId && (
        <NativeSelect id={`${idPrefix}-task`} aria-label="Task" value={taskId ?? ''} onChange={(e) => onChange({ projectId, taskId: e.target.value || null })}>
          <option value="">No specific task</option>
          {tasks.data?.data.map((t) => (
            <option key={t.id} value={t.id}>
              {t.key} {t.title}
            </option>
          ))}
        </NativeSelect>
      )}
    </div>
  );
}
