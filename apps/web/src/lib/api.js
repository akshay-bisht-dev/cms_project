import { createApiClient } from '@orbit/api-client';

/** Browser-side API client. Requests are same-origin, so the session cookie travels automatically. */
export const api = createApiClient();
