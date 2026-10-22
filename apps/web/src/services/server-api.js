import 'server-only';
import { cookies } from 'next/headers';

const API = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

/**
 * Fetches /auth/me from the API with the browser's cookies (server components only).
 * Returns null when there is no valid session. Business data is never loaded here; client
 * components fetch it through TanStack Query so permissions are enforced by the API alone.
 */
export async function getMe() {
  const cookieHeader = (await cookies()).toString();
  if (!cookieHeader.includes('orbit_sid')) return null;
  const res = await fetch(`${API}/api/v1/auth/me`, { headers: { cookie: cookieHeader }, cache: 'no-store' });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`Could not load the session (HTTP ${res.status})`);
  return (await res.json()).data;
}
