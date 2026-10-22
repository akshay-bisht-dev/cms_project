'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';

export function useEmployees(params) {
  return useQuery({
    queryKey: queryKeys.employees(params),
    queryFn: async () => api.get('/employees', { query: params }),
    placeholderData: (previous) => previous,
  });
}

export function useEmployee(employeeId) {
  return useQuery({ queryKey: queryKeys.employee(employeeId), queryFn: async () => (await api.get(`/employees/${employeeId}`)).data });
}

export function useDepartments({ includeArchived = false } = {}) {
  return useQuery({
    queryKey: [...queryKeys.departments, { includeArchived }],
    queryFn: async () => (await api.get('/departments', { query: { includeArchived } })).data,
    staleTime: 60_000,
  });
}

export function useTeams() {
  return useQuery({ queryKey: queryKeys.teams, queryFn: async () => (await api.get('/teams')).data, staleTime: 60_000 });
}

export function useRoles() {
  return useQuery({ queryKey: queryKeys.roles, queryFn: async () => (await api.get('/roles')).data, staleTime: 300_000 });
}

/** Invalidates everything derived from employee records after a change. */
export function useInvalidateEmployees() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['employees'] }),
      queryClient.invalidateQueries({ queryKey: ['employee'] }),
      queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      queryClient.invalidateQueries({ queryKey: queryKeys.departments }),
      queryClient.invalidateQueries({ queryKey: queryKeys.teams }),
    ]);
}

export function useEmployeeAction(employeeId) {
  const invalidate = useInvalidateEmployees();
  return useMutation({
    mutationFn: ({ action, body, idempotencyKey }) =>
      action === 'archive'
        ? api.delete(`/employees/${employeeId}`)
        : api.post(`/employees/${employeeId}/${action}`, body, { idempotencyKey }),
    onSuccess: invalidate,
  });
}
