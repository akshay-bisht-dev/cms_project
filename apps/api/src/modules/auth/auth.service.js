import { randomBytes } from 'node:crypto';
import { ERROR_CODES } from '@orbit/shared-constants';
import { AppError, BusinessRuleError, ForbiddenError, NotFoundError, UnauthenticatedError, ValidationError } from '../../utils/errors.js';
import { generateToken, sha256 } from '../../services/crypto.js';
import { hashPassword, needsRehash, verifyPassword } from '../../services/passwords.js';
import { generateSecret, otpauthUri, verifyTotp } from '../../services/totp.js';
import { recordAudit } from '../../services/audit.js';
import { enqueueEmail } from '../../services/email.js';
import { withTransaction } from '../../repositories/tx.js';
import { serializePermissions } from '../rbac/rbac.service.js';
import { notify } from '../notifications/notifications.service.js';

const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_BASE_MS = 15 * 60_000;
const LOCKOUT_MAX_MS = 24 * 3600_000;
const RESET_TTL_MS = 30 * 60_000;
const VERIFY_TTL_MS = 24 * 3600_000;
const RECOVERY_CODE_COUNT = 10;
const USABLE_ORG_STATUSES = ['TRIAL', 'ACTIVE', 'SUSPENDED'];

const invalidCredentials = () => new UnauthenticatedError('Invalid email or password', ERROR_CODES.INVALID_CREDENTIALS);
const invalidToken = () => new BusinessRuleError('This link is invalid or has expired', ERROR_CODES.INVALID_TOKEN);

function lockoutDuration(failedCount) {
  return Math.min(LOCKOUT_BASE_MS * 2 ** (failedCount - LOCKOUT_THRESHOLD), LOCKOUT_MAX_MS);
}

function formatRecoveryCode(raw) {
  return `${raw.slice(0, 5)}-${raw.slice(5, 10)}`;
}

function normalizeRecoveryCode(code) {
  return code.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

export function createAuthService({ prisma, env, clock, cipher, sessionService }) {
  const link = (path, token) => `${env.APP_ORIGIN}${path}?token=${encodeURIComponent(token)}`;

  async function recordAttempt(email, ip, success, reason) {
    await prisma.loginAttempt.create({ data: { emailHash: sha256(email), ip: ip ?? null, success, reason } });
  }

  async function activeMemberships(userId) {
    // Cross-tenant by nature: which organizations may this identity enter?
    return prisma.unscoped.organizationMember.findMany({
      where: { userId, status: 'ACTIVE', organization: { status: { in: USABLE_ORG_STATUSES } } },
      include: { organization: { select: { id: true, name: true, slug: true, status: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  async function issueEmailToken(db, user, purpose, ttlMs) {
    const token = generateToken();
    await db.authToken.updateMany({ where: { userId: user.id, purpose, usedAt: null }, data: { usedAt: clock.now() } });
    await db.authToken.create({
      data: { userId: user.id, purpose, tokenHash: sha256(token), expiresAt: new Date(clock.now().getTime() + ttlMs) },
    });
    return token;
  }

  async function consumeEmailToken(db, token, purpose) {
    const row = await db.authToken.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
    if (!row || row.purpose !== purpose || row.usedAt || row.expiresAt <= clock.now()) throw invalidToken();
    // Conditional update makes concurrent use of the same token fail for all but one request.
    const { count } = await db.authToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: clock.now() } });
    if (count !== 1) throw invalidToken();
    return row.user;
  }

  return {
    activeMemberships,

    async sendVerificationEmail(db, user) {
      const token = await issueEmailToken(db, user, 'VERIFY_EMAIL', VERIFY_TTL_MS);
      await enqueueEmail(db, cipher, {
        to: user.email,
        template: 'verify-email',
        data: { name: user.name },
        link: link('/verify-email', token),
        dedupeKey: `verify-email:${sha256(token)}`,
      });
    },

    async login(meta, { email, password }) {
      const user = await prisma.user.findUnique({ where: { email } });
      const passwordOk = await verifyPassword(user?.passwordHash, password);
      const now = clock.now();

      if (!user || !passwordOk) {
        if (user) {
          const failed = user.failedLoginCount + 1;
          await prisma.user.update({
            where: { id: user.id },
            data: {
              failedLoginCount: failed,
              lockedUntil: failed >= LOCKOUT_THRESHOLD ? new Date(now.getTime() + lockoutDuration(failed)) : user.lockedUntil,
            },
          });
        }
        await recordAttempt(email, meta.ip, false, user ? 'bad_password' : 'unknown_user');
        throw invalidCredentials();
      }
      // Only a caller who knows the password learns that the account is locked or unverified.
      if (user.lockedUntil && user.lockedUntil > now) {
        await recordAttempt(email, meta.ip, false, 'locked');
        throw new ForbiddenError('Too many failed attempts. Try again later or reset your password.', ERROR_CODES.ACCOUNT_LOCKED);
      }
      if (user.status !== 'ACTIVE') {
        await recordAttempt(email, meta.ip, false, 'disabled');
        throw invalidCredentials();
      }
      if (!user.emailVerifiedAt) {
        await recordAttempt(email, meta.ip, false, 'unverified');
        throw new ForbiddenError('Verify your email address before signing in', ERROR_CODES.EMAIL_NOT_VERIFIED);
      }

      const memberships = await activeMemberships(user.id);
      if (memberships.length === 0) {
        await recordAttempt(email, meta.ip, false, 'no_membership');
        throw new ForbiddenError('Your account does not have access to any active organization');
      }

      const mfa = await prisma.mfaSetting.findUnique({ where: { userId: user.id } });
      const mfaRequired = Boolean(mfa?.enabledAt);
      const organizationId = memberships.length === 1 ? memberships[0].organizationId : null;

      const { session, token } = await withTransaction(prisma, async (tx) => {
        await tx.user.update({
          where: { id: user.id },
          data: {
            failedLoginCount: 0,
            lockedUntil: null,
            lastLoginAt: now,
            ...(needsRehash(user.passwordHash) ? { passwordHash: await hashPassword(password) } : {}),
          },
        });
        const created = await sessionService.create(tx, { userId: user.id, organizationId, mfaRequired, ip: meta.ip, userAgent: meta.userAgent });
        await recordAudit(tx, { ...meta, userId: user.id }, { action: 'auth.login', organizationId, targetType: 'session', targetId: created.session.id });
        return created;
      });
      await recordAttempt(email, meta.ip, true, 'ok');

      const status = mfaRequired ? 'MFA_REQUIRED' : organizationId ? 'AUTHENTICATED' : 'ORGANIZATION_SELECTION_REQUIRED';
      return {
        token,
        session,
        status,
        organizations: mfaRequired ? [] : memberships.map((m) => ({ ...m.organization, employeeId: m.id })),
      };
    },

    async selectOrganization(ctx, { organizationId }) {
      const member = await prisma.organizationMember.findUnique({
        where: { organizationId_userId: { organizationId, userId: ctx.userId } },
        include: { organization: true },
      });
      if (!member || member.status !== 'ACTIVE' || !USABLE_ORG_STATUSES.includes(member.organization.status)) {
        throw new NotFoundError('Organization not found');
      }
      return withTransaction(prisma, async (tx) => {
        const rotated = await sessionService.rotate(tx, ctx.session.id, { activeOrganizationId: organizationId });
        await recordAudit(tx, { ...ctx, orgId: organizationId }, { action: 'auth.organization_selected', targetType: 'session', targetId: ctx.session.id });
        return rotated;
      });
    },

    async logout(ctx) {
      await withTransaction(prisma, async (tx) => {
        await sessionService.revoke(tx, { id: ctx.session.id }, 'logout');
        await recordAudit(tx, ctx, { action: 'auth.logout', targetType: 'session', targetId: ctx.session.id });
      });
    },

    async me(ctx) {
      const [memberships, mfa] = await Promise.all([
        activeMemberships(ctx.userId),
        prisma.mfaSetting.findUnique({ where: { userId: ctx.userId }, select: { enabledAt: true } }),
      ]);
      return {
        user: { ...ctx.user, mfaEnabled: Boolean(mfa?.enabledAt) },
        session: { id: ctx.session.id, expiresAt: ctx.session.expiresAt, mfaPending: Boolean(ctx.mfaPending) },
        organization: ctx.organization
          ? {
              id: ctx.organization.id,
              name: ctx.organization.name,
              slug: ctx.organization.slug,
              status: ctx.organization.status,
              timeZone: ctx.organization.timeZone,
              baseCurrency: ctx.organization.baseCurrency,
              brandColor: ctx.organization.brandColor,
            }
          : null,
        employeeId: ctx.member?.id ?? null,
        memberType: ctx.member?.memberType ?? null,
        clientId: ctx.member?.memberType === 'CLIENT' ? ctx.member.clientId : null,
        permissions: serializePermissions(ctx.permissions ?? new Map()),
        mfaEnrollmentRequired: Boolean(ctx.mfaEnrollmentRequired),
        organizations: ctx.mfaPending ? [] : memberships.map((m) => ({ ...m.organization, employeeId: m.id })),
      };
    },

    async listSessions(ctx) {
      const sessions = await prisma.userSession.findMany({
        where: { userId: ctx.userId, revokedAt: null, expiresAt: { gt: clock.now() } },
        orderBy: { lastSeenAt: 'desc' },
        select: { id: true, ip: true, userAgent: true, deviceLabel: true, createdAt: true, lastSeenAt: true, expiresAt: true },
      });
      return sessions.map((s) => ({ ...s, current: s.id === ctx.session.id }));
    },

    async revokeSession(ctx, sessionId) {
      await withTransaction(prisma, async (tx) => {
        const { count } = await sessionService.revoke(tx, { id: sessionId, userId: ctx.userId }, 'user_revoked');
        if (count === 0) throw new NotFoundError('Session not found');
        await recordAudit(tx, ctx, { action: 'auth.session_revoked', targetType: 'session', targetId: sessionId });
      });
    },

    async changePassword(ctx, { currentPassword, newPassword }) {
      const user = await prisma.user.findUnique({ where: { id: ctx.userId } });
      if (!(await verifyPassword(user.passwordHash, currentPassword))) {
        throw new ValidationError([{ path: 'body.currentPassword', message: 'Current password is incorrect' }]);
      }
      const passwordHash = await hashPassword(newPassword);
      return withTransaction(prisma, async (tx) => {
        await tx.user.update({ where: { id: user.id }, data: { passwordHash, passwordChangedAt: clock.now() } });
        await sessionService.revoke(tx, { userId: user.id, id: { not: ctx.session.id } }, 'password_changed');
        const rotated = await sessionService.rotate(tx, ctx.session.id);
        await recordAudit(tx, ctx, { action: 'auth.password_changed', targetType: 'user', targetId: user.id });
        await enqueueEmail(tx, cipher, {
          to: user.email,
          template: 'password-changed',
          data: { name: user.name },
          dedupeKey: `password-changed:${user.id}:${clock.now().getTime()}`,
        });
        return rotated;
      });
    },

    async forgotPassword(meta, { email }) {
      const user = await prisma.user.findUnique({ where: { email } });
      if (!user || user.status !== 'ACTIVE' || !user.passwordHash) return;
      await withTransaction(prisma, async (tx) => {
        const token = await issueEmailToken(tx, user, 'RESET_PASSWORD', RESET_TTL_MS);
        await enqueueEmail(tx, cipher, {
          to: user.email,
          template: 'reset-password',
          data: { name: user.name },
          link: link('/reset-password', token),
          dedupeKey: `reset-password:${sha256(token)}`,
        });
        await recordAudit(tx, { ...meta, userId: user.id }, { action: 'auth.password_reset_requested', organizationId: null, targetType: 'user', targetId: user.id });
      });
    },

    async resetPassword(meta, { token, password }) {
      const passwordHash = await hashPassword(password);
      await withTransaction(prisma, async (tx) => {
        const user = await consumeEmailToken(tx, token, 'RESET_PASSWORD');
        const now = clock.now();
        await tx.user.update({
          where: { id: user.id },
          data: { passwordHash, passwordChangedAt: now, failedLoginCount: 0, lockedUntil: null, emailVerifiedAt: user.emailVerifiedAt ?? now },
        });
        await sessionService.revoke(tx, { userId: user.id }, 'password_reset');
        // A password reset signs out everywhere, including desktop apps in every organization.
        await tx.$executeRaw`UPDATE desktop_agents SET status = 'REVOKED', revoked_at = ${now}, last_nonce_hash = NULL WHERE user_id = ${user.id} AND status = 'ACTIVE'`;
        await recordAudit(tx, { ...meta, userId: user.id }, { action: 'auth.password_reset', organizationId: null, targetType: 'user', targetId: user.id });
      });
    },

    async verifyEmail(meta, { token }) {
      await withTransaction(prisma, async (tx) => {
        const user = await consumeEmailToken(tx, token, 'VERIFY_EMAIL');
        await tx.user.update({ where: { id: user.id }, data: { emailVerifiedAt: user.emailVerifiedAt ?? clock.now() } });
        await recordAudit(tx, { ...meta, userId: user.id }, { action: 'auth.email_verified', organizationId: null, targetType: 'user', targetId: user.id });
      });
    },

    async resendVerification({ email }) {
      const user = await prisma.user.findUnique({ where: { email } });
      if (!user || user.emailVerifiedAt || !user.passwordHash) return;
      await withTransaction(prisma, (tx) => this.sendVerificationEmail(tx, user));
    },

    async getInvitation({ token }) {
      const invitation = await findUsableInvitation(prisma, token, clock);
      return {
        email: invitation.email,
        name: invitation.member.user.name,
        organizationName: invitation.organization.name,
        requiresPassword: !invitation.member.user.passwordHash,
        expiresAt: invitation.expiresAt,
      };
    },

    async acceptInvitation(meta, { token, password, name }) {
      const passwordHash = password ? await hashPassword(password) : null;
      return withTransaction(prisma, async (tx) => {
        const invitation = await findUsableInvitation(tx, token, clock);
        const user = invitation.member.user;
        if (!user.passwordHash && !passwordHash) {
          throw new ValidationError([{ path: 'body.password', message: 'Choose a password to activate your account' }]);
        }
        const { count } = await tx.invitation.updateMany({
          where: { organizationId: invitation.organizationId, id: invitation.id, acceptedAt: null, revokedAt: null },
          data: { acceptedAt: clock.now() },
        });
        if (count !== 1) throw invalidToken();

        const now = clock.now();
        await tx.user.update({
          where: { id: user.id },
          data: {
            emailVerifiedAt: user.emailVerifiedAt ?? now,
            ...(user.passwordHash ? {} : { passwordHash, passwordChangedAt: now }),
            ...(name && !user.passwordHash ? { name } : {}),
          },
        });
        await tx.organizationMember.update({
          where: { organizationId_userId: { organizationId: invitation.organizationId, userId: user.id } },
          data: { status: 'ACTIVE', joinedAt: now },
        });
        await recordAudit(tx, { ...meta, userId: user.id }, {
          action: 'employees.invitation_accepted',
          organizationId: invitation.organizationId,
          targetType: 'invitation',
          targetId: invitation.id,
        });
        const inviter = invitation.invitedById
          ? await tx.organizationMember.findUnique({
              where: { organizationId_userId: { organizationId: invitation.organizationId, userId: invitation.invitedById } },
            })
          : null;
        if (inviter?.status === 'ACTIVE') {
          await notify(tx, meta, {
            cipher,
            appOrigin: env.APP_ORIGIN,
            organizationId: invitation.organizationId,
            recipientUserId: inviter.userId,
            type: 'employees.invitation_accepted',
            title: `${name && !user.passwordHash ? name : user.name} joined ${invitation.organization.name}`,
            link: `/employees/${invitation.member.id}`,
            subjectType: 'employee',
            subjectId: invitation.member.id,
            dedupeKey: `invitation-accepted:${invitation.id}`,
          });
        }
        return { organizationId: invitation.organizationId, email: user.email };
      });
    },

    // ─── MFA ────────────────────────────────────────────────────────────────

    async mfaSetup(ctx) {
      const existing = await prisma.mfaSetting.findUnique({ where: { userId: ctx.userId } });
      if (existing?.enabledAt) throw new BusinessRuleError('Two-factor authentication is already enabled');
      const secret = generateSecret();
      await prisma.mfaSetting.upsert({
        where: { userId: ctx.userId },
        update: { pendingSecretEnc: cipher.encrypt(secret) },
        create: { userId: ctx.userId, pendingSecretEnc: cipher.encrypt(secret) },
      });
      return { secret, otpauthUri: otpauthUri({ secret, accountName: ctx.user.email, issuer: 'Orbit' }) };
    },

    async mfaEnable(ctx, { code }) {
      const setting = await prisma.mfaSetting.findUnique({ where: { userId: ctx.userId } });
      if (setting?.enabledAt) throw new BusinessRuleError('Two-factor authentication is already enabled');
      if (!setting?.pendingSecretEnc) throw new BusinessRuleError('Start two-factor setup first');
      const secret = cipher.decrypt(setting.pendingSecretEnc);
      const step = verifyTotp(secret, code, clock.now());
      if (step === null) throw new ValidationError([{ path: 'body.code', message: 'The code is incorrect or expired' }]);

      const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, () => randomBytes(8).toString('hex').slice(0, 10));
      const rotated = await withTransaction(prisma, async (tx) => {
        await tx.mfaSetting.update({
          where: { userId: ctx.userId },
          data: {
            secretEnc: setting.pendingSecretEnc,
            pendingSecretEnc: null,
            enabledAt: clock.now(),
            lastUsedStep: BigInt(step),
            recoveryCodeHashes: recoveryCodes.map((c) => sha256(c)),
          },
        });
        const result = await sessionService.rotate(tx, ctx.session.id, { mfaRequired: true, mfaVerifiedAt: clock.now() });
        await sessionService.revoke(tx, { userId: ctx.userId, id: { not: ctx.session.id } }, 'mfa_enabled');
        await recordAudit(tx, ctx, { action: 'auth.mfa_enabled', targetType: 'user', targetId: ctx.userId });
        return result;
      });
      return { ...rotated, recoveryCodes: recoveryCodes.map(formatRecoveryCode) };
    },

    async mfaVerify(ctx, { code, recoveryCode }) {
      const setting = await prisma.mfaSetting.findUnique({ where: { userId: ctx.userId } });
      if (!setting?.enabledAt) throw new BusinessRuleError('Two-factor authentication is not enabled');

      const update = {};
      if (code) {
        const step = verifyTotp(cipher.decrypt(setting.secretEnc), code, clock.now());
        // Reject reuse of a code from an already-used time step (replay protection).
        if (step === null || (setting.lastUsedStep !== null && BigInt(step) <= setting.lastUsedStep)) {
          throw new UnauthenticatedError('The code is incorrect or expired', ERROR_CODES.MFA_REQUIRED);
        }
        update.lastUsedStep = BigInt(step);
      } else {
        const hashes = setting.recoveryCodeHashes ?? [];
        const hash = sha256(normalizeRecoveryCode(recoveryCode));
        if (!hashes.includes(hash)) throw new UnauthenticatedError('The recovery code is incorrect', ERROR_CODES.MFA_REQUIRED);
        update.recoveryCodeHashes = hashes.filter((h) => h !== hash);
      }

      return withTransaction(prisma, async (tx) => {
        await tx.mfaSetting.update({ where: { userId: ctx.userId }, data: update });
        const rotated = await sessionService.rotate(tx, ctx.session.id, { mfaVerifiedAt: clock.now() });
        await recordAudit(tx, { ...ctx, orgId: ctx.session.activeOrganizationId }, {
          action: recoveryCode ? 'auth.mfa_recovery_code_used' : 'auth.mfa_verified',
          targetType: 'session',
          targetId: ctx.session.id,
        });
        return rotated;
      });
    },

    async mfaDisable(ctx, { password, code }) {
      const [user, setting] = await Promise.all([
        prisma.user.findUnique({ where: { id: ctx.userId } }),
        prisma.mfaSetting.findUnique({ where: { userId: ctx.userId } }),
      ]);
      if (!setting?.enabledAt) throw new BusinessRuleError('Two-factor authentication is not enabled');
      if (ctx.orgSettings?.security?.mfaRequired) {
        throw new ForbiddenError('Your organization requires two-factor authentication', ERROR_CODES.MFA_ENROLLMENT_REQUIRED);
      }
      const passwordOk = await verifyPassword(user.passwordHash, password);
      const step = verifyTotp(cipher.decrypt(setting.secretEnc), code, clock.now());
      if (!passwordOk || step === null) throw new ValidationError([{ path: 'body', message: 'Password or code is incorrect' }]);
      await withTransaction(prisma, async (tx) => {
        await tx.mfaSetting.delete({ where: { userId: ctx.userId } });
        await tx.userSession.updateMany({ where: { userId: ctx.userId }, data: { mfaRequired: false } });
        await recordAudit(tx, ctx, { action: 'auth.mfa_disabled', targetType: 'user', targetId: ctx.userId });
      });
    },
  };
}

async function findUsableInvitation(db, token, clock) {
  const invitation = await db.invitation.findUnique({
    where: { tokenHash: sha256(token) },
    include: { organization: true, member: { include: { user: true } } },
  });
  if (
    !invitation ||
    invitation.acceptedAt ||
    invitation.revokedAt ||
    invitation.expiresAt <= clock.now() ||
    invitation.member.status !== 'INVITED' ||
    !['TRIAL', 'ACTIVE'].includes(invitation.organization.status)
  ) {
    throw new AppError(422, ERROR_CODES.INVALID_TOKEN, 'This invitation is invalid or has expired');
  }
  return invitation;
}
