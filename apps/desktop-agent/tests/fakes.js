import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createLocalQueue } from '../src/local-queue.js';
import { createDeviceKeys } from '../src/authentication.js';

export async function tempQueue(options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'orbit-queue-'));
  return { dir, queue: createLocalQueue({ dir, key: randomBytes(32), ...options }) };
}

export function memorySecrets() {
  const map = new Map();
  return { map, read: async (k) => map.get(k) ?? null, write: async (k, v) => void map.set(k, v), remove: async (k) => void map.delete(k) };
}

export function memoryStore(initial = null) {
  let value = initial;
  return { load: async () => value, save: async (v) => void (value = v), clear: async () => void (value = null), get value() { return value; } };
}

export const keysFor = (secrets = memorySecrets()) => createDeviceKeys({ secrets });

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
export const ok = (data) => json(200, { success: true, data });
export const fail = (status, code, message = code) => json(status, { success: false, error: { code, message, details: [] } });

/**
 * A scripted fake of the Orbit server: `routes[path]` is a function (body, req) → response.
 * Records every call for assertions.
 */
export function fakeServer(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    const key = u.pathname.replace('/api/v1/monitoring/agent', '') || u.pathname;
    const body = init.body && typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    calls.push({ path: key, url, method: init.method, headers: init.headers, body });
    const handler = routes[key] ?? (u.hostname === 'storage.test' ? routes.storage : null);
    if (!handler) throw new TypeError(`fetch failed: no route ${key}`);
    return handler(body, init);
  };
  return { calls, fetchImpl };
}
