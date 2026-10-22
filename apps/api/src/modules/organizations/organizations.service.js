import { ConflictError } from '../../utils/errors.js';
import { recordAudit } from '../../services/audit.js';
import { hashPassword } from '../../services/passwords.js';
import { withTransaction } from '../../repositories/tx.js';
import { createSystemRoles } from '../rbac/rbac.service.js';
import { OWNER_ROLE_KEY } from '../rbac/index.js';
import { SETTINGS_SCHEMAS, getOrganizationSettings, mergeSettings } from './settings.js';
import { withCompletion } from '../employees/fields.js';

function slugify(name) {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base.length >= 3 ? base : `org-${base}`.slice(0, 40);
}

async function uniqueSlug(db, desired, explicit) {
  if (explicit) {
    if (await db.organization.findUnique({ where: { slug: desired } })) throw new ConflictError('This organization URL is already taken');
    return desired;
  }
  for (let n = 1; n < 50; n += 1) {
    const candidate = n === 1 ? desired : `${desired}-${n}`;
    if (!(await db.organization.findUnique({ where: { slug: candidate } }))) return candidate;
  }
  throw new ConflictError('Could not find a free organization URL; choose one explicitly');
}

/**
 * Creates an organization with its settings row, system roles, and an ACTIVE owner membership.
 * Shared by public registration and the development seed.
 */
export async function createOrganizationWithOwner(tx, { name, slug, timeZone, baseCurrency, status = 'TRIAL', ownerUserId }) {
  const organization = await tx.organization.create({ data: { name, slug, timeZone, baseCurrency, status } });
  await tx.organizationSettings.create({ data: { organizationId: organization.id, data: {} } });
  const roles = await createSystemRoles(tx, organization.id);
  const member = await tx.organizationMember.create({
    data: { organizationId: organization.id, userId: ownerUserId, status: 'ACTIVE', joinedAt: new Date() },
  });
  await tx.employeeProfile.create({ data: withCompletion({ organizationId: organization.id, userId: ownerUserId, timeZone }) });
  await tx.memberRole.create({ data: { organizationId: organization.id, userId: ownerUserId, roleId: roles[OWNER_ROLE_KEY].id } });
  return { organization, member, roles };
}

export function createOrganizationService({ prisma, authService }) {
  return {
    async register(meta, body) {
      const passwordHash = await hashPassword(body.password);
      return withTransaction(prisma, async (tx) => {
        if (await tx.user.findUnique({ where: { email: body.email } })) {
          throw new ConflictError('An account with this email already exists. Sign in to continue.');
        }
        const slug = await uniqueSlug(tx, body.slug ?? slugify(body.organizationName), Boolean(body.slug));
        const user = await tx.user.create({ data: { email: body.email, name: body.ownerName, passwordHash, passwordChangedAt: new Date() } });
        const { organization, member } = await createOrganizationWithOwner(tx, {
          name: body.organizationName,
          slug,
          timeZone: body.timeZone,
          baseCurrency: body.baseCurrency,
          ownerUserId: user.id,
        });
        await authService.sendVerificationEmail(tx, user);
        await recordAudit(tx, { ...meta, userId: user.id, orgId: organization.id }, {
          action: 'organizations.registered',
          targetType: 'organization',
          targetId: organization.id,
        });
        return { organizationId: organization.id, slug, employeeId: member.id, emailVerificationRequired: true };
      });
    },

    async getCurrent(ctx) {
      const [organization, memberCount] = await Promise.all([
        prisma.organization.findUnique({ where: { id: ctx.orgId } }),
        prisma.organizationMember.count({ where: { organizationId: ctx.orgId, status: { in: ['ACTIVE', 'INVITED'] } } }),
      ]);
      const { storageLimitBytes, ...rest } = organization;
      return { ...rest, storageLimitBytes: storageLimitBytes === null ? null : Number(storageLimitBytes), memberCount };
    },

    async updateCurrent(ctx, patch) {
      return withTransaction(prisma, async (tx) => {
        const before = await tx.organization.findUnique({ where: { id: ctx.orgId } });
        await tx.organization.update({ where: { id: ctx.orgId }, data: patch });
        const diff = Object.fromEntries(Object.keys(patch).map((k) => [k, { from: before[k], to: patch[k] }]));
        await recordAudit(tx, ctx, { action: 'organizations.updated', targetType: 'organization', targetId: ctx.orgId, diff });
      }).then(() => this.getCurrent(ctx));
    },

    async getSettings(ctx) {
      return getOrganizationSettings(prisma, ctx.orgId);
    },

    /** Replaces one settings section. Validated against the section schema; audited with a diff. */
    async updateSettingsSection(ctx, section, input) {
      const value = SETTINGS_SCHEMAS[section].parse(input);
      return withTransaction(prisma, async (tx) => {
        const row = await tx.organizationSettings.findUnique({ where: { organizationId: ctx.orgId } });
        const current = mergeSettings(row?.data);
        const data = { ...(row?.data ?? {}), [section]: value };
        await tx.organizationSettings.upsert({
          where: { organizationId: ctx.orgId },
          update: { data, version: { increment: 1 } },
          create: { organizationId: ctx.orgId, data, version: 1 },
        });
        await recordAudit(tx, ctx, {
          action: 'organizations.settings_updated',
          targetType: 'organization_settings',
          targetId: ctx.orgId,
          diff: { section, from: current[section], to: value },
        });
        return { section, value };
      });
    },
  };
}
