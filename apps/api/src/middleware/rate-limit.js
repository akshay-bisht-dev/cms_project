import { ERROR_CODES } from '@orbit/shared-constants';
import { AppError } from '../utils/errors.js';
import { RATE_LIMITS } from '../services/rate-limiter.js';

/**
 * Applies a rate-limit class. If the shared store (Redis) is unavailable, counting falls back to
 * `fallbackStore` (in-process memory): a cache outage must not take the API down, but limits such as
 * login attempts per IP must not vanish either (each replica then enforces them on its own). With no
 * fallback the request is allowed.
 */
export function rateLimit(className, { store, fallbackStore = null, enabled = true }) {
  const rules = RATE_LIMITS[className];
  if (!rules) throw new Error(`Unknown rate-limit class "${className}"`);
  return async (req, res, next) => {
    if (!enabled) return next();
    for (const rule of rules) {
      const key = rule.key(req);
      if (!key) continue;
      let hit;
      try {
        hit = await store.hit(`${className}:${key}`, rule.windowMs);
      } catch (err) {
        if (!fallbackStore) {
          req.log?.warn({ err: err.message, className }, 'rate limiter unavailable; allowing request');
          return next();
        }
        req.log?.warn({ err: err.message, className }, 'rate limiter unavailable; counting in memory');
        hit = await fallbackStore.hit(`${className}:${key}`, rule.windowMs);
      }
      const { count, resetAt } = hit;
      if (count > rule.limit) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))));
        return next(new AppError(429, ERROR_CODES.RATE_LIMITED, 'Too many requests; please try again later'));
      }
    }
    next();
  };
}
