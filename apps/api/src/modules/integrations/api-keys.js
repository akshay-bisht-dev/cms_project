import { randomBytes } from 'node:crypto';
import { ERROR_CODES } from '@orbit/shared-constants';
import { ForbiddenError, NotFoundError, UnauthenticatedError, ValidationError } from '../../utils/errors.js';
import { recordAudit } from '../../services/audit.js';
import { safeEqual, sha256 } from '../../services/crypto.js';
import { hasPermission, loadEffectivePermissions } from '../rbac/rbac.service.js';
import { getOrganizationSettings } from '../organizations/settings.js';
import { memberSummaries } from '../shared/members.js';

const KEY_RE = /^orb_([a-z0-9]{12})_([A-Za-z0-9_-]{43})$/;
const TOUCH_EVERY_MS = 60_000;

export function generateApiKey() {
  const prefix = randomBytes(12).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '').padEnd(12, '0').slice(0, 12);
  return { prefix, key: `orb_${prefix}_${randomBytes(32).toString('base64url')}` };
}

/**
 * Authenticates "Authorization: Bearer orb_…" (FR-INT-2). A key acts for the member who created
 * it, limited to its scopes AND to what that member may still do now (both re-checked on every
 * request), and only on routes declared `apiKey: true`. Failures are recorded on req.apiKeyError
 * and reported by `authorize`.
 */
export function apiKeyContext({ prisma, clock }) {
  return async (req, _res, next) => {
    const header = req.get('authorization');
    if (!header?.startsWith('Bearer orb_')) return next();
    if (req.ctx.session) {
      req.apiKeyError = new UnauthenticatedError('Send either a session cookie or an API key, not both', ERROR_CODES.INVALID_TOKEN);
      return next();
    }
    try {
      const invalid = new UnauthenticatedError('The API key is invalid, expired or revoked', ERROR_CODES.INVALID_TOKEN);
      const raw = header.slice(7).trim();
      const match = KEY_RE.exec(raw);
      if (!match) throw invalid;
      const key = await prisma.unscoped.apiKey.findUnique({ where: { prefix: match[1] } });
      if (!key || !safeEqual(key.keyHash, sha256(raw)) || key.revokedAt || (key.expiresAt && key.expiresAt <= clock.now())) throw invalid;
      const member = await prisma.organizationMember.findUnique({
        where: { organizationId_userId: { organizationId: key.organizationId, userId: key.createdById } },
        include: { organization: true, user: { select: { id: true, email: true, name: true, status: true } } },
      });
      if (member?.status !== 'ACTIVE' || member.user.status !== 'ACTIVE' || !['ACTIVE', 'TRIAL'].includes(member.organization.status)) throw invalid;

      const creatorPermissions = await loadEffectivePermissions(prisma, key.organizationId, key.createdById);
      const permissions = new Map([...creatorPermissions].filter(([k]) => key.scopes.includes(k)));
      Object.assign(req.ctx, {
        apiKey: { id: key.id, name: key.name },
        orgId: key.organizationId,
        userId: key.createdById,
        user: { id: member.user.id, email: member.user.email, name: member.user.name },
        member,
        organization: member.organization,
        orgSettings: (await getOrganizationSettings(prisma, key.organizationId)).settings,
        permissions,
      });
      if (!key.lastUsedAt || clock.now() - key.lastUsedAt > TOUCH_EVERY_MS) {
        await prisma.apiKey.updateMany({ where: { organizationId: key.organizationId, id: key.id }, data: { lastUsedAt: clock.now() } });
      }
    } catch (err) {
      req.apiKeyError = err;
    }
    next();
  };
}

export function createApiKeyService({ prisma, clock }) {
  const serialize = (k, people) => ({
    id: k.id,
    name: k.name,
    prefix: `orb_${k.prefix}`,
    scopes: k.scopes,
    expiresAt: k.expiresAt,
    lastUsedAt: k.lastUsedAt,
    revokedAt: k.revokedAt,
    createdAt: k.createdAt,
    createdBy: people?.get(k.createdById) ? { id: people.get(k.createdById).employeeId, name: people.get(k.createdById).name } : null,
  });

  return {
    async list(ctx, { mine }) {
      const canManage = hasPermission(ctx, 'apikeys.manage');
      const rows = await prisma.apiKey.findMany({ where: { organizationId: ctx.orgId, ...(mine || !canManage ? { createdById: ctx.userId } : {}) }, orderBy: { createdAt: 'desc' } });
      const people = await memberSummaries(prisma, ctx.orgId, rows.map((r) => r.createdById));
      return rows.map((k) => serialize(k, people));
    },

    /** The key is shown once. Scopes may not exceed the creator's own permissions. */
    async create(ctx, { name, scopes, expiresInDays }) {
      const missing = scopes.filter((s) => !hasPermission(ctx, s));
      if (missing.length) throw new ValidationError([{ path: 'body.scopes', message: `You do not hold: ${missing.join(', ')}` }]);
      const { prefix, key } = generateApiKey();
      const created = await prisma.apiKey.create({
        data: { organizationId: ctx.orgId, name, prefix, keyHash: sha256(key), scopes: [...new Set(scopes)], expiresAt: expiresInDays ? new Date(clock.now().getTime() + expiresInDays * 86_400_000) : null, createdById: ctx.userId, createdAt: clock.now() },
      });
      await recordAudit(prisma, ctx, { action: 'apikeys.created', targetType: 'api_key', targetId: created.id, diff: { name, scopes, expiresInDays: expiresInDays ?? null } });
      return { ...serialize(created), key };
    },

    async revoke(ctx, keyId) {
      const key = await prisma.apiKey.findFirst({ where: { organizationId: ctx.orgId, id: keyId } });
      if (!key || (key.createdById !== ctx.userId && !hasPermission(ctx, 'apikeys.manage'))) throw new NotFoundError('API key not found');
      if (key.revokedAt) return;
      await prisma.apiKey.updateMany({ where: { organizationId: ctx.orgId, id: key.id }, data: { revokedAt: clock.now() } });
      await recordAudit(prisma, ctx, { action: 'apikeys.revoked', targetType: 'api_key', targetId: key.id, diff: { name: key.name } });
    },

    assertNotApiKey(ctx) {
      if (ctx.apiKey) throw new ForbiddenError('API keys cannot manage API keys');
    },
  };
}
