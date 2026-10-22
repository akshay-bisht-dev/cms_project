'use client';

import { useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

/** Reads and writes query-string state, so filtered views can be shared and survive reloads. */
export function useUrlState(defaults) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const state = Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [key, params.get(key) ?? fallback]));

  const setState = useCallback(
    (updates) => {
      const next = new URLSearchParams(params.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value === '' || value === null || value === undefined || value === defaults[key]) next.delete(key);
        else next.set(key, value);
      }
      const query = next.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [params, router, pathname, defaults],
  );

  return [state, setState];
}
