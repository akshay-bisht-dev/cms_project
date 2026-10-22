'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export const projectKeys = {
  all: ['projects'],
  list: (params) => ['projects', 'list', params],
  detail: (id) => ['projects', id],
  summary: (id) => ['projects', id, 'summary'],
  statuses: (id) => ['projects', id, 'statuses'],
  members: (id) => ['projects', id, 'members'],
  milestones: (id) => ['projects', id, 'milestones'],
  tasks: (params) => ['tasks', 'list', params],
  task: (id) => ['tasks', id],
  labels: ['labels'],
  calendar: (params) => ['calendar', params],
};

const get = (path, query) => async () => (await api.get(path, query ? { query } : undefined)).data;

export const useProjects = (params = {}) => useQuery({ queryKey: projectKeys.list(params), queryFn: get('/projects', params) });
export const useProject = (id) => useQuery({ queryKey: projectKeys.detail(id), queryFn: get(`/projects/${id}`), enabled: Boolean(id) });
export const useProjectSummary = (id) => useQuery({ queryKey: projectKeys.summary(id), queryFn: get(`/projects/${id}/summary`) });
export const useStatuses = (id) => useQuery({ queryKey: projectKeys.statuses(id), queryFn: get(`/projects/${id}/statuses`), enabled: Boolean(id), staleTime: 60_000 });
export const useProjectMembers = (id) => useQuery({ queryKey: projectKeys.members(id), queryFn: get(`/projects/${id}/members`), enabled: Boolean(id), staleTime: 60_000 });
export const useMilestones = (id) => useQuery({ queryKey: projectKeys.milestones(id), queryFn: get(`/projects/${id}/milestones`), enabled: Boolean(id) });
export const useTasks = (params, options = {}) =>
  useQuery({ queryKey: projectKeys.tasks(params), queryFn: async () => api.get('/tasks', { query: params }), ...options });
export const useTask = (id) => useQuery({ queryKey: projectKeys.task(id), queryFn: get(`/tasks/${id}`) });
export const useLabels = () => useQuery({ queryKey: projectKeys.labels, queryFn: get('/labels'), staleTime: 300_000 });

/** After a task or project change, refresh everything derived from it. */
export function useInvalidateWork() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all(['projects', 'tasks', 'calendar', 'dashboard', 'time-entries'].map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
}
