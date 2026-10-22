import { ERROR_CODES } from '@orbit/shared-constants';
import { ForbiddenError, UnauthenticatedError } from '../../utils/errors.js';
import { getOrganizationSettings } from '../organizations/settings.js';

/**
 * Authenticates desktop agents (Authorization: Bearer <agent token>). On success req.ctx gains
 * `agent` plus the member's org/user identity; `authorize` only lets that identity reach routes
 * declared with permission AGENT, so an agent token can never act as a browser session.
 * Failures are recorded on req.agentError and reported by `authorize` for AGENT routes.
 */
export function agentContext({ prisma, agentTokens }) {
  return async (req, _res, next) => {
    const header = req.get('authorization');
    if (!header?.startsWith('Bearer ') || header.startsWith('Bearer orb_')) return next(); // orb_ = API key
    if (req.ctx.session) {
      req.agentError = new UnauthenticatedError('Send either a session cookie or an agent token, not both', ERROR_CODES.INVALID_TOKEN);
      return next();
    }
    try {
      const claims = agentTokens.verify(header.slice(7).trim());
      // Agent ids are globally unique; the row's organization must match the token's.
      const agent = await prisma.unscoped.desktopAgent.findUnique({ where: { id: claims.sub } });
      if (!agent || agent.organizationId !== claims.org || agent.userId !== claims.mem) throw new UnauthenticatedError('The agent token is invalid', ERROR_CODES.INVALID_TOKEN);
      if (agent.status !== 'ACTIVE') throw new UnauthenticatedError('This device has been disconnected', ERROR_CODES.AGENT_REVOKED);

      const member = await prisma.organizationMember.findUnique({
        where: { organizationId_userId: { organizationId: agent.organizationId, userId: agent.userId } },
        include: { organization: true, user: { select: { id: true, email: true, name: true, status: true } } },
      });
      if (!member || member.status !== 'ACTIVE' || member.user.status !== 'ACTIVE' || member.organization.status === 'CLOSED') {
        throw new UnauthenticatedError('This device has been disconnected', ERROR_CODES.AGENT_REVOKED);
      }
      if (member.organization.status === 'SUSPENDED') throw new ForbiddenError('This organization is suspended', ERROR_CODES.ORG_SUSPENDED);

      const ctx = req.ctx;
      ctx.agent = agent;
      ctx.orgId = agent.organizationId;
      ctx.userId = agent.userId;
      ctx.user = { id: member.user.id, email: member.user.email, name: member.user.name };
      ctx.member = member;
      ctx.organization = member.organization;
      ctx.orgSettings = (await getOrganizationSettings(prisma, ctx.orgId)).settings;
    } catch (err) {
      req.agentError = err;
    }
    next();
  };
}
