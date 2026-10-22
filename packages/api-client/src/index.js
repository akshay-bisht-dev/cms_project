import { API_PREFIX } from '@orbit/shared-constants';

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const CSRF_COOKIE = 'orbit_csrf';

export class ApiError extends Error {
  constructor({ status, code, message, details = [], requestId = null }) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

function readCookie(name) {
  const cookie = globalThis.document?.cookie;
  if (!cookie) return undefined;
  const match = cookie.split('; ').find((c) => c.startsWith(`${name}=`) || c.startsWith(`__Host-${name}=`));
  return match ? decodeURIComponent(match.split('=').slice(1).join('=')) : undefined;
}

/**
 * Creates a client for the Orbit REST API. Unwraps the `{ success, data, meta }` envelope
 * and throws ApiError for `{ success: false }` responses.
 */
export function createApiClient({ baseUrl = '', fetchImpl, headers: defaultHeaders = {} } = {}) {
  async function request(method, path, { body, query, headers = {}, idempotencyKey, signal } = {}) {
    const url = new URL(`${baseUrl}${API_PREFIX}${path}`, baseUrl || globalThis.location?.origin || 'http://localhost');
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
      }
    }

    const finalHeaders = { Accept: 'application/json', ...defaultHeaders, ...headers };
    if (body !== undefined) finalHeaders['Content-Type'] = 'application/json';
    if (idempotencyKey) finalHeaders['Idempotency-Key'] = idempotencyKey;
    if (UNSAFE_METHODS.has(method)) {
      const csrf = readCookie(CSRF_COOKIE);
      if (csrf) finalHeaders['X-CSRF-Token'] = csrf;
    }

    let response;
    try {
      // Resolved per call so polyfills and test stubs installed after import are honoured.
      response = await (fetchImpl ?? globalThis.fetch)(url, {
        method,
        headers: finalHeaders,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'same-origin',
        signal,
      });
    } catch (cause) {
      if (cause?.name === 'AbortError') throw cause;
      throw new ApiError({ status: 0, code: 'NETWORK_ERROR', message: 'Could not reach the server' });
    }

    const payload = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok || payload?.success === false) {
      throw new ApiError({
        status: response.status,
        code: payload?.error?.code ?? 'INTERNAL_ERROR',
        message: payload?.error?.message ?? `Request failed with status ${response.status}`,
        details: payload?.error?.details ?? [],
        requestId: payload?.requestId ?? response.headers.get('x-request-id'),
      });
    }
    return { data: payload?.data ?? null, meta: payload?.meta ?? {} };
  }

  return {
    request,
    get: (path, options) => request('GET', path, options),
    post: (path, body, options) => request('POST', path, { ...options, body }),
    put: (path, body, options) => request('PUT', path, { ...options, body }),
    patch: (path, body, options) => request('PATCH', path, { ...options, body }),
    delete: (path, options) => request('DELETE', path, options),
  };
}
