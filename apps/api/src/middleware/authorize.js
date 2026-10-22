import { ERROR_CODES } from '@orbit/shared-constants';
import { ForbiddenError, UnauthenticatedError } from '../utils/errors.js';
import { hasPermission } from '../modules/rbac/rbac.service.js';

/** No authentication required. */
export const PUBLIC = 'public';
/** A valid session, with or without an active organization (e.g. choosing an organization). */
export const SESSION = 'session';
/** An active membership in the session's organization, without a specific permission. */
export const MEMBER = 'member';
/** A desktop agent's bearer token (modules/monitoring/agent-context.js); browser sessions are refused. */
export const AGENT = 'agent';

/**
 * Enforces a route's declared access level. Runs before validation, so callers without access
 * learn nothing about the request shape. Scope checks against specific targets happen in services.
 */
export function authorize(permission, { allowMfaPending = false, allowMfaEnrollment = false, allowClient = false, apiKey = false } = {}) {
  return (req, _res, next) => {
    if (permission === PUBLIC) return next();
    const ctx = req.ctx ?? {};

    // Agent tokens only ever reach agent routes, and agent routes only accept agent tokens.
    if (permission === AGENT) {
      if (ctx.agent) return next();
      return next(req.agentError ?? new UnauthenticatedError('A desktop agent token is required'));
    }
    if (ctx.agent) return next(new UnauthenticatedError('Agent tokens cannot be used for this request'));
    // API keys reach only routes built for integrations (`apiKey: true`).
    if (req.apiKeyError) return next(req.apiKeyError);
    if (ctx.apiKey && (!apiKey || permission === PUBLIC || permission === SESSION)) {
      return next(new ForbiddenError('API keys cannot use this endpoint', ERROR_CODES.FORBIDDEN));
    }

    if (!ctx.userId) {
      const expired = req.sessionError && req.sessionError !== 'unknown';
      return next(
        expired
          ? new UnauthenticatedError('Your session has expired; please sign in again', ERROR_CODES.SESSION_EXPIRED)
          : new UnauthenticatedError(),
      );
    }
    if (ctx.mfaPending && !allowMfaPending) {
      return next(new UnauthenticatedError('Enter your verification code to continue', ERROR_CODES.MFA_REQUIRED));
    }
    if (permission === SESSION) return next();

    if (!ctx.orgId) {
      return next(new ForbiddenError('Select an organization to continue', ERROR_CODES.ORGANIZATION_REQUIRED));
    }
    if (ctx.orgSuspended) {
      return next(new ForbiddenError('This organization is suspended', ERROR_CODES.ORG_SUSPENDED));
    }
    if (ctx.mfaEnrollmentRequired && !allowMfaEnrollment) {
      return next(new ForbiddenError('Your organization requires two-factor authentication', ERROR_CODES.MFA_ENROLLMENT_REQUIRED));
    }
    // Client portal users (member type CLIENT) only reach routes built for them; every internal
    // route is closed to them regardless of permissions, so a mis-granted role cannot leak data.
    if (ctx.member?.memberType === 'CLIENT' && !allowClient) {
      return next(new ForbiddenError('Client users can only use the client portal'));
    }
    if (permission === MEMBER || hasPermission(ctx, permission)) return next();
    next(new ForbiddenError());
  };
}
