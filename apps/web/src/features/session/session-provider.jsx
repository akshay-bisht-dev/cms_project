'use client';

import { createContext, useContext } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { can } from '@/lib/permissions';
import { queryKeys } from '@/lib/query-keys';

const SessionContext = createContext(null);

/** Holds the signed-in user's /auth/me payload, seeded by the server layout and kept fresh. */
export function SessionProvider({ initialMe, children }) {
  const { data: me } = useQuery({
    queryKey: queryKeys.me,
    queryFn: async () => (await api.get('/auth/me')).data,
    initialData: initialMe,
    staleTime: 60_000,
  });
  return <SessionContext.Provider value={me}>{children}</SessionContext.Provider>;
}

export function useMe() {
  const me = useContext(SessionContext);
  if (!me) throw new Error('useMe must be used inside SessionProvider');
  return me;
}

export function useCan(key, scope) {
  return can(useMe(), key, scope);
}
