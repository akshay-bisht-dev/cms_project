'use client';

import { useCan } from '@/features/session/session-provider';

/** Renders children only when the user holds the permission (UI convenience; the API enforces). */
export function Can({ permission, scope, fallback = null, children }) {
  return useCan(permission, scope) ? children : fallback;
}
