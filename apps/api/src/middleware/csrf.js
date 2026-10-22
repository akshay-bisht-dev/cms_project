import { ERROR_CODES } from '@orbit/shared-constants';
import { ForbiddenError } from '../utils/errors.js';
import { safeEqual } from '../services/crypto.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence for cookie-authenticated requests:
 *  1. Unsafe requests carrying an Origin header must come from APP_ORIGIN (also stops login CSRF).
 *  2. With a session cookie, X-CSRF-Token must equal HMAC(CSRF_SECRET, sessionId) (double-submit).
 * SameSite=Lax cookies are the third layer.
 */
export function csrfProtection({ env, sessionService }) {
  const allowedOrigin = new URL(env.APP_ORIGIN).origin;
  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();

    const origin = req.get('origin');
    if (origin && origin !== allowedOrigin) {
      return next(new ForbiddenError('Cross-origin request rejected', ERROR_CODES.CSRF_INVALID));
    }
    if (req.ctx?.session) {
      const expected = sessionService.csrfTokenFor(req.ctx.session.id);
      if (!safeEqual(req.get('x-csrf-token'), expected)) {
        return next(new ForbiddenError('Missing or invalid CSRF token', ERROR_CODES.CSRF_INVALID));
      }
    }
    next();
  };
}
