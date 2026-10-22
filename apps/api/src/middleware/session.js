import { loadEffectivePermissions } from '../modules/rbac/rbac.service.js';
import { getOrganizationSettings } from '../modules/organizations/settings.js';

/**
 * Builds req.ctx for every request: request metadata always; user, session, active organization,
 * membership and effective permissions when a valid session cookie is present.
 */
export function sessionContext({ prisma, sessionService }) {
  return async (req, res, next) => {
    // afterCommit: side effects (real-time pushes) that run only if the request succeeds.
    req.ctx = { requestId: req.id, ip: req.ip, userAgent: req.get('user-agent') ?? null, permissions: new Map(), afterCommit: [] };

    const token = req.cookies?.[sessionService.names.session];
    if (!token) return next();

    const { session, reason } = await sessionService.resolve(token);
    if (!session) {
      req.sessionError = reason;
      sessionService.clearCookies(res);
      return next();
    }

    const ctx = req.ctx;
    ctx.session = session;
    ctx.user = { id: session.user.id, email: session.user.email, name: session.user.name };
    ctx.userId = session.user.id;
    ctx.mfaPending = session.mfaRequired && !session.mfaVerifiedAt;

    if (session.activeOrganizationId && !ctx.mfaPending) {
      const member = await prisma.organizationMember.findUnique({
        where: { organizationId_userId: { organizationId: session.activeOrganizationId, userId: session.userId } },
        include: { organization: true },
      });
      if (member && member.status === 'ACTIVE' && member.organization.status !== 'CLOSED') {
        ctx.orgId = member.organizationId;
        ctx.member = member;
        ctx.organization = member.organization;
        ctx.orgSuspended = member.organization.status === 'SUSPENDED';
        const [{ settings }, permissions, mfa] = await Promise.all([
          getOrganizationSettings(prisma, ctx.orgId),
          loadEffectivePermissions(prisma, ctx.orgId, ctx.userId),
          prisma.mfaSetting.findUnique({ where: { userId: ctx.userId }, select: { enabledAt: true } }),
        ]);
        ctx.orgSettings = settings;
        ctx.permissions = permissions;
        ctx.mfaEnrollmentRequired = settings.security.mfaRequired && !mfa?.enabledAt;
      }
    }
    next();
  };
}
