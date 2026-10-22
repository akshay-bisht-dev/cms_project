import { describe, expect, it } from 'vitest';
import { rateLimit } from '../../src/middleware/rate-limit.js';
import { createMemoryRateLimitStore } from '../../src/services/rate-limiter.js';

function run(middleware, req = {}) {
  const headers = {};
  return new Promise((resolve) => {
    middleware({ ip: '1.2.3.4', ctx: { userId: 'u1' }, body: {}, ...req }, { setHeader: (k, v) => (headers[k] = v) }, (err) => resolve({ err, headers }));
  });
}

describe('rate limit middleware', () => {
  it('allows up to the limit and then answers 429 with Retry-After', async () => {
    const mw = rateLimit('auth-strict', { store: createMemoryRateLimitStore() });
    const results = [];
    for (let i = 0; i < 6; i += 1) results.push(await run(mw, { body: { email: 'A@b.test' } }));
    expect(results.slice(0, 5).every((r) => r.err === undefined)).toBe(true);
    expect(results[5].err.status).toBe(429);
    expect(Number(results[5].headers['Retry-After'])).toBeGreaterThan(0);
  });

  it('fails open when the store is unavailable and no fallback is given', async () => {
    const broken = { hit: async () => { throw new Error('ECONNREFUSED'); } };
    const { err } = await run(rateLimit('write', { store: broken }));
    expect(err).toBeUndefined();
  });

  it('keeps enforcing limits in memory while the shared store is down', async () => {
    const broken = { hit: async () => { throw new Error('ECONNREFUSED'); } };
    const mw = rateLimit('auth-strict', { store: broken, fallbackStore: createMemoryRateLimitStore() });
    const results = [];
    for (let i = 0; i < 6; i += 1) results.push(await run(mw, { body: { email: 'a@b.test' } }));
    expect(results.slice(0, 5).every((r) => r.err === undefined)).toBe(true);
    expect(results[5].err.status).toBe(429);
  });

  it('keeps the in-memory store bounded', async () => {
    let t = 0;
    const store = createMemoryRateLimitStore({ now: () => t, maxKeys: 3 });
    for (const k of ['a', 'b', 'c']) await store.hit(k, 1000);
    t = 2000; // all three expired
    await store.hit('d', 1000);
    expect(store.size()).toBe(1);
    for (const k of ['e', 'f', 'g', 'h']) await store.hit(k, 1000);
    expect(store.size()).toBeLessThanOrEqual(4);
  });

  it('can be disabled', async () => {
    const store = { hit: async () => ({ count: 1e9, resetAt: Date.now() }) };
    const { err } = await run(rateLimit('read', { store, enabled: false }));
    expect(err).toBeUndefined();
  });
});
