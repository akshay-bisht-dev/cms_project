'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';

const get = (path, query) => async () => (await api.get(path, query ? { query } : undefined)).data;

export const crmKeys = {
  all: ['crm'],
  clients: (p) => ['crm', 'clients', p],
  client: (id) => ['crm', 'client', id],
  notes: (id) => ['crm', 'client', id, 'notes'],
  agreements: (id) => ['crm', 'client', id, 'agreements'],
  portalUsers: (id) => ['crm', 'client', id, 'portal-users'],
  leads: (p) => ['crm', 'leads', p],
  stages: ['crm', 'stages'],
  opportunities: (p) => ['crm', 'opportunities', p],
  pipeline: (p) => ['crm', 'pipeline', p],
  quotes: (p) => ['crm', 'quotes', p],
  quote: (id) => ['crm', 'quote', id],
  activities: (p) => ['crm', 'activities', p],
};

export const useClients = (params = {}, enabled = true) => useQuery({ queryKey: crmKeys.clients(params), queryFn: get('/clients', params), enabled });
export const useClient = (id) => useQuery({ queryKey: crmKeys.client(id), queryFn: get(`/clients/${id}`) });
export const useStages = (enabled = true) => useQuery({ queryKey: crmKeys.stages, queryFn: get('/pipeline-stages'), enabled });

/** Runs `fn`, toasts the result, and refreshes everything under `keys` (default: all CRM data). */
export function useAction(fn, { success, onSuccess, keys = [crmKeys.all] } = {}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (data, vars) => {
      if (success) toast.success(typeof success === 'function' ? success(data, vars) : success);
      for (const key of keys) queryClient.invalidateQueries({ queryKey: key });
      onSuccess?.(data, vars);
    },
    onError: (error) => toast.error(error.details?.[0]?.message ?? error.message),
  });
}

export const newKey = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
