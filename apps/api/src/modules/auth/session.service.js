import { generateToken, hmac, sha256 } from '../../services/crypto.js';

const TOUCH_INTERVAL_MS = 60_000;

export function cookieNames(env) {
  // __Host- cookies must be Secure, Path=/ and have no Domain: they cannot be set by subdomains.
  const prefix = env.cookieSecure ? '__Host-' : '';
  return { session: `${prefix}orbit_sid`, csrf: `${prefix}orbit_csrf` };
}

/**
 * Opaque server-side sessions (ADR D2). The cookie holds a random token; the database holds
 * only its SHA-256, so a database leak does not yield usable sessions.
 */
export function createSessionService({ prisma, env, clock }) {
  const names = cookieNames(env);
  const idleMs = env.SESSION_IDLE_MINUTES * 60_000;
  const absoluteMs = env.SESSION_ABSOLUTE_DAYS * 86_400_000;

  const cookieOptions = (expires) => ({
    httpOnly: true,
    secure: env.cookieSecure,
    sameSite: 'lax',
    path: '/',
    expires,
  });

  return {
    names,

    csrfTokenFor(sessionId) {
      return hmac(env.CSRF_SECRET, `csrf:${sessionId}`);
    },

    async create(db, { userId, organizationId = null, mfaRequired = false, ip, userAgent }) {
      const token = generateToken();
      const now = clock.now();
      const session = await db.userSession.create({
        data: {
          userId,
          activeOrganizationId: organizationId,
          tokenHash: sha256(token),
          mfaRequired,
          ip: ip ?? null,
          userAgent: userAgent?.slice(0, 512) ?? null,
          lastSeenAt: now,
          expiresAt: new Date(now.getTime() + absoluteMs),
        },
      });
      return { session, token };
    },

    /** Issues a new token for an existing session (login step-up, MFA, org switch). */
    async rotate(db, sessionId, data = {}) {
      const token = generateToken();
      const session = await db.userSession.update({ where: { id: sessionId }, data: { ...data, tokenHash: sha256(token) } });
      return { session, token };
    },

    /**
     * Looks up a session by cookie token. Returns { session } when usable, otherwise
     * { reason } ('unknown' | 'revoked' | 'expired' | 'idle' | 'user_disabled').
     */
    async resolve(token) {
      const session = await prisma.userSession.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
      if (!session) return { reason: 'unknown' };
      const now = clock.now();
      if (session.revokedAt) return { reason: 'revoked' };
      if (session.expiresAt <= now) return { reason: 'expired' };
      if (session.lastSeenAt.getTime() + idleMs <= now.getTime()) return { reason: 'idle' };
      if (session.user.status !== 'ACTIVE') return { reason: 'user_disabled' };
      if (now.getTime() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
        await prisma.userSession.update({ where: { id: session.id }, data: { lastSeenAt: now } });
      }
      return { session };
    },

    revoke(db, where, reason) {
      return db.userSession.updateMany({ where: { ...where, revokedAt: null }, data: { revokedAt: clock.now(), revokeReason: reason } });
    },

    setCookies(res, token, session) {
      res.cookie(names.session, token, cookieOptions(session.expiresAt));
      // Readable by the SPA; echoed back in X-CSRF-Token (double-submit, bound to the session).
      res.cookie(names.csrf, this.csrfTokenFor(session.id), { ...cookieOptions(session.expiresAt), httpOnly: false });
    },

    clearCookies(res) {
      res.clearCookie(names.session, cookieOptions());
      res.clearCookie(names.csrf, { ...cookieOptions(), httpOnly: false });
    },
  };
}
