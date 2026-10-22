'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';

export const monitoringKeys = {
  all: ['monitoring'],
  me: ['monitoring', 'me'],
  policies: ['monitoring', 'policies'],
  versions: (policyId) => ['monitoring', 'policies', policyId, 'versions'],
  effective: (employeeId) => ['monitoring', 'effective', employeeId ?? 'me'],
  agents: (employeeId) => ['monitoring', 'agents', employeeId ?? 'all'],
  screenshots: (params) => ['monitoring', 'screenshots', params],
  timeline: (params) => ['monitoring', 'timeline', params],
  screenshot: (id) => ['monitoring', 'screenshot', id],
  accessLog: (id) => ['monitoring', 'screenshot', id, 'access-log'],
  thumbs: (ids) => ['monitoring', 'thumbs', ids],
  holds: ['monitoring', 'legal-holds'],
  deletions: (params) => ['monitoring', 'deletions', params],
};

export const useMyMonitoring = () => useQuery({ queryKey: monitoringKeys.me, queryFn: async () => (await api.get('/monitoring/me')).data });

export const usePolicies = (enabled = true) =>
  useQuery({ queryKey: monitoringKeys.policies, queryFn: async () => (await api.get('/monitoring/policies')).data, enabled });

export const useEffectivePolicy = (employeeId) =>
  useQuery({ queryKey: monitoringKeys.effective(employeeId), queryFn: async () => (await api.get('/monitoring/policies/effective', { query: { employeeId } })).data });

export const useAgents = (employeeId) =>
  useQuery({ queryKey: monitoringKeys.agents(employeeId), queryFn: async () => (await api.get('/monitoring/agents', { query: { employeeId } })).data });

export const useTimeline = (params, enabled = true) =>
  useQuery({ queryKey: monitoringKeys.timeline(params), queryFn: async () => (await api.get('/monitoring/timeline', { query: params })).data, enabled });

/**
 * Signed thumbnail URLs for a set of screenshots. They expire after 60 s and each request is
 * logged server-side, so they are fetched once per set and not refetched on focus.
 */
export function useThumbUrls(ids) {
  const key = [...ids].sort().join(',');
  return useQuery({
    queryKey: monitoringKeys.thumbs(key),
    queryFn: async () => {
      const urls = new Map();
      for (let i = 0; i < ids.length; i += 60) {
        const { data } = await api.post('/monitoring/screenshots/access-urls', { ids: ids.slice(i, i + 60), variant: 'thumb' });
        for (const u of data) urls.set(u.id, u.url);
      }
      return urls;
    },
    enabled: ids.length > 0,
    staleTime: 50_000,
    gcTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

/** Opens a signed URL for a full-size view or download (each one is logged). */
export async function openScreenshot(id, variant) {
  const { data } = await api.post('/monitoring/screenshots/access-urls', { ids: [id], variant });
  return data[0]?.url ?? null;
}

/** Mutation helper: runs `fn`, toasts the outcome and refreshes monitoring queries. */
export function useMonitoringMutation(fn, { success, onSuccess } = {}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (data, variables) => {
      if (success) toast.success(typeof success === 'function' ? success(data, variables) : success);
      queryClient.invalidateQueries({ queryKey: monitoringKeys.all });
      onSuccess?.(data, variables);
    },
    onError: (error) => toast.error(error.details?.[0]?.message ?? error.message),
  });
}
