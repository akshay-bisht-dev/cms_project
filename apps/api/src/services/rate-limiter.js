/**
 * Fixed-window counters with a pluggable store: Redis in deployed environments (shared across
 * replicas), memory for tests and single-process development.
 */
export function createMemoryRateLimitStore({ now = () => Date.now(), maxKeys = 100_000 } = {}) {
  const windows = new Map();
  // Bounded memory (this store also backs production while Redis is down): drop expired windows,
  // then the oldest ones, once the map grows past maxKeys.
  const prune = (t) => {
    for (const [k, e] of windows) if (e.resetAt <= t) windows.delete(k);
    for (const k of windows.keys()) {
      if (windows.size <= maxKeys) break;
      windows.delete(k);
    }
  };
  return {
    size: () => windows.size,
    async hit(key, windowMs) {
      const t = now();
      if (windows.size >= maxKeys && !windows.has(key)) prune(t);
      const entry = windows.get(key);
      if (!entry || entry.resetAt <= t) {
        windows.set(key, { count: 1, resetAt: t + windowMs });
        return { count: 1, resetAt: t + windowMs };
      }
      entry.count += 1;
      return { ...entry };
    },
    async reset(key) {
      windows.delete(key);
    },
  };
}

export function createRedisRateLimitStore(redis, prefix = 'rl:') {
  return {
    async hit(key, windowMs) {
      const fullKey = `${prefix}${key}`;
      const results = await redis.multi().incr(fullKey).pttl(fullKey).exec();
      const count = Number(results[0][1]);
      let ttl = Number(results[1][1]);
      if (ttl < 0) {
        await redis.pexpire(fullKey, windowMs);
        ttl = windowMs;
      }
      return { count, resetAt: Date.now() + ttl };
    },
    async reset(key) {
      await redis.del(`${prefix}${key}`);
    },
  };
}

/** Rate-limit classes from docs/api-reference.md. */
export const RATE_LIMITS = Object.freeze({
  'auth-strict': [
    { name: 'ip', limit: 20, windowMs: 60_000, key: (req) => `ip:${req.ip}` },
    { name: 'ip-account', limit: 5, windowMs: 60_000, key: (req) => (req.body?.email ? `ip-acct:${req.ip}:${String(req.body.email).toLowerCase()}` : null) },
  ],
  // Pairing and token exchange for desktop agents: unauthenticated, so bounded per IP.
  'agent-auth': [{ name: 'ip', limit: 30, windowMs: 60_000, key: (req) => `agent-ip:${req.ip}` }],
  // Authenticated agent traffic (heartbeat every 60 s, a few uploads per interval).
  agent: [{ name: 'agent', limit: 120, windowMs: 60_000, key: (req) => `agent:${req.ctx?.agent?.id ?? req.ip}` }],
  // Report exports are expensive background jobs.
  export: [{ name: 'member', limit: 10, windowMs: 3600_000, key: (req) => `x:${req.ctx?.userId ?? req.ip}` }],
  // Integrations authenticated with an API key: per key, per hour (FR-INT-2).
  'api-key': [{ name: 'key', limit: 1000, windowMs: 3600_000, key: (req) => `k:${req.ctx?.apiKey?.id ?? req.ip}` }],
  write: [{ name: 'member', limit: 120, windowMs: 60_000, key: (req) => `w:${req.ctx?.userId ?? req.ip}` }],
  read: [{ name: 'member', limit: 600, windowMs: 60_000, key: (req) => `r:${req.ctx?.userId ?? req.ip}` }],
});
