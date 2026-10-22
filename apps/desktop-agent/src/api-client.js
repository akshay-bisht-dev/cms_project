/** An error response from the Orbit API (status + error code), or a network failure (status 0). */
export class AgentApiError extends Error {
  constructor({ status, code, message, details = [] }) {
    super(message);
    this.name = 'AgentApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** Retrying cannot help: the server understood and refused the request. */
  get permanent() {
    return this.status >= 400 && this.status < 500 && this.status !== 401 && this.status !== 408 && this.status !== 429;
  }
}

/** Only HTTPS servers, except a local development server. */
export function normalizeServerUrl(input) {
  let url;
  try {
    url = new URL(String(input).trim());
  } catch {
    throw new Error('Enter the full address of your Orbit server, e.g. https://orbit.example.com');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new Error('The server address must use https://');
  return url.origin;
}

/**
 * Minimal client for the agent endpoints under /api/v1/monitoring/agent. `getToken` supplies the
 * bearer token for authenticated calls.
 */
export function createAgentApi({ serverUrl, fetchImpl = globalThis.fetch, getToken = () => null, userAgent = 'OrbitDesktop' }) {
  const base = `${serverUrl}/api/v1/monitoring/agent`;

  async function call(path, body, { auth = true } = {}) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': userAgent };
    if (auth) headers.Authorization = `Bearer ${getToken()}`;
    let res;
    try {
      res = await fetchImpl(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
    } catch (cause) {
      throw new AgentApiError({ status: 0, code: 'NETWORK_ERROR', message: cause?.message ?? 'Network error' });
    }
    const payload = await res.json().catch(() => null);
    if (!res.ok || payload?.success === false) {
      throw new AgentApiError({
        status: res.status,
        code: payload?.error?.code ?? 'HTTP_ERROR',
        message: payload?.error?.message ?? `Request failed (${res.status})`,
        details: payload?.error?.details ?? [],
      });
    }
    return payload?.data ?? null;
  }

  return {
    register: (body) => call('/register', body, { auth: false }),
    challenge: (agentId) => call('/challenge', { agentId }, { auth: false }),
    token: (body) => call('/token', body, { auth: false }),
    heartbeat: (body) => call('/heartbeat', body),
    presign: (body) => call('/uploads/presign', body),
    complete: (screenshotId) => call('/uploads/complete', { screenshotId }),
    fail: (body) => call('/uploads/fail', body),
    idle: (body) => call('/idle', body),

    /** Uploads bytes to the signed storage URL (not the API). */
    async put(upload, bytes) {
      let res;
      try {
        res = await fetchImpl(upload.url, { method: upload.method ?? 'PUT', headers: upload.headers ?? {}, body: bytes });
      } catch (cause) {
        throw new AgentApiError({ status: 0, code: 'NETWORK_ERROR', message: cause?.message ?? 'Network error' });
      }
      if (!res.ok) throw new AgentApiError({ status: res.status >= 500 ? res.status : 502, code: 'STORAGE_ERROR', message: `Storage upload failed (${res.status})` });
    },
  };
}
